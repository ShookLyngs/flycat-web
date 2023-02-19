import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { connect } from 'react-redux';
import {
  Nip19DataPrefix,
  Nip19DataType,
  nip19Decode,
  nip19Encode,
} from 'service/api';
import { matchKeyPair, randomKeyPair } from 'service/crypto';
import {
  login,
  LoginActionType,
  LoginMode,
  LoginRequest,
} from 'store/loginReducer';

const styles = {
  pk: {
    fontSize: '12px',
    color: 'gray',
    display: 'block',
    marginBottom: '10px',
  },
  title: {
    fontSize: '20px',
    fontWeight: '500',
    display: 'block',
    margin: '10px 0px',
  },
  input: {
    width: '100%',
    display: 'block',
    marginBottom: '5px',
    padding: '5px',
  },
};

export interface LoginFormProps {
  isLoggedIn;
  publicKey;
  privateKey;
  doLogin;
  doLogout;
  onCancel: () => any;
}

const LoginForm = ({
  isLoggedIn,
  publicKey,
  privateKey,
  doLogin,
  doLogout,
  onCancel,
}: LoginFormProps) => {
  const { t } = useTranslation();

  const [pubKeyInputValue, setPubKeyInputValue] = useState<string>('');
  const [privKeyInputValue, setPrivKeyInputValue] = useState<string>('');

  const newKeyPair = () => {
    const data = randomKeyPair();
    setPubKeyInputValue(data.pubKey);
    setPrivKeyInputValue(data.privKey);
  };

  const signWithNip07 = async () => {
    if (typeof window.webln !== 'undefined') {
      await window.webln.enable();
      console.debug('lighting wallet: window.webln enabled');
    }

    if (!window.nostr) {
      return alert(
        'window.nostr not found! did you install the Nip07 wallet extension?',
      );
    }

    const loginRequest: LoginRequest = {
      mode: LoginMode.nip07,
    };
    doLogin(loginRequest);
  };

  if (isLoggedIn) {
    return (
      <div>
        <span style={styles.title}>{t('loginForm.welcome')}</span>
        <span style={styles.pk}>
          {publicKey &&
            t('loginForm.signAs') +
              ' ' +
              nip19Encode(publicKey, Nip19DataType.Pubkey)}
        </span>
        <button onClick={doLogout}>{t('loginForm.signOut')}</button>&nbsp;&nbsp;
        <button onClick={onCancel}>{t('loginForm.cancel')}</button>
      </div>
    );
  } else {
    return (
      <form
        onSubmit={event => {
          event.preventDefault();
          let pubKey = event.currentTarget.publicKey.value;
          let privKey = event.currentTarget.privateKey.value;

          if (typeof pubKey !== 'string') {
            alert('typeof pubKey !== "string"');
            return;
          }
          if (typeof privKey !== 'string') {
            alert('typeof privKey !== "string"');
            return;
          }

          if (pubKey.startsWith(Nip19DataPrefix.Pubkey)) {
            const res = nip19Decode(pubKey);
            if (res.type !== Nip19DataType.Pubkey) {
              return alert('bech32 encoded publickey decoded err');
            }
            pubKey = res.data;
            console.log(pubKey, pubKey.length);
          }

          if (pubKey.length !== 64) {
            alert('only support 32 bytes hex publicKey now, wrong length');
            return;
          }

          if (privKey.length > 0) {
            if (privKey.startsWith(Nip19DataPrefix.Privkey)) {
              const res = nip19Decode(privKey);
              if (res.type !== Nip19DataType.Privkey) {
                return alert('bech32 encoded privkey decoded err');
              }
              privKey = res.data;
            }

            if (pubKey.length !== 64) {
              alert('only support 32 bytes hex private key now, wrong length');
              return;
            }

            if (!matchKeyPair(pubKey, privKey)) {
              alert('public key and private key not matched!');
              return;
            }
          }

          const loginRequest: LoginRequest = {
            mode: LoginMode.local,
            publicKey: pubKey,
            privateKey: privKey,
          };
          doLogin(loginRequest);
        }}
      >
        <span style={styles.title}>{t('nav.menu.signIn')}</span>
        <label>
          <input
            type="text"
            placeholder={t('loginForm.pubKey') + t('loginForm.pkHint')}
            name="publicKey"
            style={styles.input}
            value={pubKeyInputValue}
            onChange={event => setPubKeyInputValue(event.target.value)}
          />
          <input
            type="text"
            placeholder={t('loginForm.privKey') + t('loginForm.privHint')}
            name="privateKey"
            style={styles.input}
            value={privKeyInputValue}
            onChange={event => setPrivKeyInputValue(event.target.value)}
          />
        </label>
        <br />
        <button type="button" onClick={signWithNip07}>
          {t('loginForm.signWithNip07')}
        </button>
        &nbsp;&nbsp;
        <button type="submit">{t('loginForm.signIn')}</button>
        &nbsp;&nbsp;
        <button type="button" onClick={newKeyPair}>
          {t('loginForm.genNewKey')}
        </button>
        &nbsp;&nbsp;
        <button type="button" onClick={onCancel}>
          {t('loginForm.cancel')}
        </button>
      </form>
    );
  }
};

const logout = () => ({
  type: 'LOGOUT',
});

const mapStateToProps = state => ({
  isLoggedIn: state.loginReducer.isLoggedIn,
  publicKey: state.loginReducer.publicKey,
  privateKey: state.loginReducer.privateKey,
});

const mapDispatchToProps = dispatch => ({
  doLogin: (request: LoginRequest) => dispatch(login(request)),
  doLogout: () => dispatch(logout()),
});

export default connect(mapStateToProps, mapDispatchToProps)(LoginForm);
