import { newSubId, randomSubId } from 'core/worker/util';
import { SubscriptionId } from 'core/nostr/type';
import { seedRelays } from 'core/relay/pool/seed';
import { WorkerEventEmitter } from './bus';
import {
  CallRelayType,
  FromWorkerMessageData,
  FromWorkerMessageType,
  PubEventMsg,
  SubFilterMsg,
  SwitchRelays,
  ToWorkerMessageData,
  ToWorkerMessageType,
  WsConnectStatus,
} from './type';
import { WS } from 'core/api/ws';

export const workerEventEmitter = new WorkerEventEmitter();

export class Pool {
  private wsList: WS[] = [];
  private portSubs: Map<number, SubscriptionId[]> = new Map(); // portId to keep-alive subIds

  public wsConnectStatus: WsConnectStatus = new Map();
  public maxSub: number;
  public maxKeepAliveSub: number;
  public switchRelays: SwitchRelays;

  constructor(relays: SwitchRelays, maxSub = 10, maxKeepAliveSub = 2) {
    console.log('init Pool..');

    this.maxSub = maxSub;
    this.maxKeepAliveSub = maxKeepAliveSub;
    this.switchRelays = relays;

    this.listen();
    this.setupWebSocketApis();
  }

  startMonitor() {
    setInterval(() => {
      console.debug(
        `portSubs(only keep-alive): ${this.portSubs.size}`,
        this.portSubs,
      );
      this.wsList
        .filter(ws => ws.isConnected())
        .forEach(ws => {
          console.debug(
            `${
              ws.url
            } subs: active ${ws.activeSubscriptions.getSize()}, pending ${
              ws.pendingSubscriptions.size
            }`,
          );
        });
    }, 10 * 1000);
  }

  closeAll() {
    for (const ws of this.wsList) {
      ws.close();
    }
    this.wsList = [];
    this.wsConnectStatus.clear();
    this.sendWsConnectStatusUpdate();
  }

  setupWebSocketApis() {
    this.switchRelays.relays
      .map(r => r.url)
      .forEach(relayUrl => {
        const onmessage = (event: MessageEvent) => {
          const msg: FromWorkerMessageData = {
            nostrData: event.data,
            relayUrl,
          };
          workerEventEmitter.emit(FromWorkerMessageType.NOSTR_DATA, msg);
        };

        if (!this.wsConnectStatus.has(relayUrl)) {
          const onOpen = _event => {
            if (ws.isConnected() === true) {
              this.wsConnectStatus.set(relayUrl, true);
              console.log(`WebSocket connection to ${relayUrl} connected`);
              this.sendWsConnectStatusUpdate();
            }
          };
          const onerror = (event: globalThis.Event) => {
            console.error(`WebSocket error: `, event);
            this.wsConnectStatus.set(relayUrl, false);
          };
          const onclose = () => {
            if (this.wsConnectStatus.get(relayUrl) === true) {
              console.log(`WebSocket connection to ${relayUrl} closed`);
              this.wsConnectStatus.set(relayUrl, false);
              this.sendWsConnectStatusUpdate();
            }
          };

          const ws = new WS(relayUrl, this.maxSub, true);
          ws.onOpen(onOpen);
          ws.onError(onerror);
          ws.addCloseListener(onclose);

          this.wsConnectStatus.set(relayUrl, false);
          this.wsList.push(ws);
        }
      });
  }

  private listen() {
    workerEventEmitter.on(
      ToWorkerMessageType.SWITCH_RELAYS,
      (message: ToWorkerMessageData) => {
        if (message.switchRelays) {
          this.closeAll();
          this.switchRelays = message.switchRelays;
          this.setupWebSocketApis();
        }
      },
    );

    workerEventEmitter.on(
      ToWorkerMessageType.ADD_RELAY_URL,
      (message: ToWorkerMessageData) => {
        if (message.urls) {
          message.urls.forEach(url => {
            if (!this.wsConnectStatus.has(url)) {
              this.switchRelays.relays.push({
                url,
                read: true,
                write: true,
              });
              this.setupWebSocketApis();
            }
          });
        }
      },
    );

    workerEventEmitter.on(
      ToWorkerMessageType.PULL_RELAY_STATUS,
      (_message: ToWorkerMessageData) => {
        this.sendWsConnectStatusUpdate();
      },
    );

    workerEventEmitter.on(
      ToWorkerMessageType.GET_RELAY_GROUP_ID,
      (_message: ToWorkerMessageData) => {
        this.sendRelayGroupId();
      },
    );

    workerEventEmitter.on(
      ToWorkerMessageType.CALL_API,
      (message: ToWorkerMessageData) => {
        const portId = message.portId;
        const callRelayType = message.callRelayType;
        const urls = message.callRelayUrls;
        const callMethod = message.callMethod;
        const callData = message.callData || [];
        if (callMethod == null) {
          console.error('callMethod can not be null for CALL_API');
          return;
        }

        this.wsList
          .filter(ws => {
            switch (callRelayType) {
              case CallRelayType.all:
                return true;

              case CallRelayType.connected:
                return ws.isConnected();

              case CallRelayType.batch:
                if (urls == null)
                  throw new Error('null callRelayUrls for CallRelayType.batch');
                return urls.includes(ws.url);

              case CallRelayType.single:
                if (urls == null || urls.length !== 1)
                  throw new Error(
                    'callRelayUrls.length != 1 or is null for CallRelayType.single',
                  );
                return urls[0] === ws.url;

              default:
                return ws.isConnected();
            }
          })
          .map(ws => {
            const method = ws[callMethod];
            if (typeof method === 'function') {
              // record custom sub id to port id
              // todo: maybe also record non-keep-alive subscription id to portId
              if (callMethod === 'subFilter') {
                const keepAlive = callData[1];
                const customSubId = callData[2];
                const subId = newSubId(
                  message.portId,
                  customSubId || randomSubId(),
                );
                callData[2] = subId; // update with portId packed;
                if (keepAlive === true) {
                  const data = this.portSubs.get(portId);
                  if (data != null && !data.includes(subId)) {
                    data.push(subId);
                    this.portSubs.set(portId, data);
                  } else {
                    console.debug('create new portSub', portId);
                    this.portSubs.set(portId, [subId]);
                  }
                }
              }

              method.apply(ws, callData);
            } else {
              console.error(`method ${callMethod} not found`);
            }
          });
      },
    );

    workerEventEmitter.on(
      ToWorkerMessageType.DISCONNECT,
      (_message: ToWorkerMessageData) => {
        this.wsList.forEach(ws => ws.close());
      },
    );

    workerEventEmitter.on(
      ToWorkerMessageType.CLOSE_PORT,
      (message: ToWorkerMessageData) => {
        const portId = message.portId;
        const subIds = this.portSubs.get(portId);
        if (subIds && subIds.length > 0) {
          for (const id of subIds) {
            this.wsList
              .filter(ws => ws.isConnected())
              // todo fix: can not close websocket since other port need them.
              .forEach(ws => ws.close());
          }
        }
        this.portSubs.delete(portId);
      },
    );
  }

  doSwitchRelays(switchRelays: SwitchRelays) {
    this.closeAll();
    this.switchRelays = switchRelays;
    this.setupWebSocketApis();
  }

  doAddRelays(urls: string[]) {
    urls.forEach(url => {
      if (!this.wsConnectStatus.has(url)) {
        this.switchRelays.relays.push({
          url,
          read: true,
          write: true,
        });
        this.setupWebSocketApis();
      }
    });
  }

  subFilter(message: SubFilterMsg) {
    const portId = message.portId;
    const callRelayType = message.callRelays.type;
    const urls = message.callRelays.data;
    const subId = message.subId;
    const filter = message.filter;

    return this.wsList
      .filter(ws => {
        switch (callRelayType) {
          case CallRelayType.all:
            return true;

          case CallRelayType.connected:
            return ws.isConnected();

          case CallRelayType.batch:
            if (urls == null)
              throw new Error('null callRelayUrls for CallRelayType.batch');
            return urls.includes(ws.url);

          case CallRelayType.single:
            if (urls == null || urls.length !== 1)
              throw new Error(
                'callRelayUrls.length != 1 or is null for CallRelayType.single',
              );
            return urls[0] === ws.url;

          default:
            return ws.isConnected();
        }
      })
      .map(ws => {
            const filterSubId = newSubId(
              message.portId,
              subId || randomSubId(),
            );
            
            const data = this.portSubs.get(portId);
              if (data != null && !data.includes(filterSubId)) {
                data.push(filterSubId);
                this.portSubs.set(portId, data);
              } else {
                console.debug('create new portSub', portId);
                this.portSubs.set(portId, [filterSubId]);
              }

            return ws.subFilter(filter, filterSubId);
      });
  }

  pubEvent(message: PubEventMsg){
    const portId = message.portId;
    const callRelayType = message.callRelays.type;
    const urls = message.callRelays.data;
    const event = message.event; 

    return this.wsList
      .filter(ws => {
        switch (callRelayType) {
          case CallRelayType.all:
            return true;

          case CallRelayType.connected:
            return ws.isConnected();

          case CallRelayType.batch:
            if (urls == null)
              throw new Error('null callRelayUrls for CallRelayType.batch');
            return urls.includes(ws.url);

          case CallRelayType.single:
            if (urls == null || urls.length !== 1)
              throw new Error(
                'callRelayUrls.length != 1 or is null for CallRelayType.single',
              );
            return urls[0] === ws.url;

          default:
            return ws.isConnected();
        }
      })
      .map(ws => {
        return ws.pubEvent(event);
      });
  }

  private sendWsConnectStatusUpdate() {
    const msg: FromWorkerMessageData = {
      wsConnectStatus: this.wsConnectStatus,
    };
    workerEventEmitter.emit(FromWorkerMessageType.WS_CONN_STATUS, msg);
  }

  private sendRelayGroupId() {
    const msg: FromWorkerMessageData = {
      relayGroupId: this.switchRelays.id,
    };
    console.log('send relay group id: ', msg);
    workerEventEmitter.emit(FromWorkerMessageType.RELAY_GROUP_ID, msg);
  }
}

export const pool = new Pool({
  id: 'default',
  relays: seedRelays.map(url => {
    return { url, read: true, write: true };
  }),
});

