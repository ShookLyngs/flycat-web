import { UserMap } from 'service/type';
import { BlogFeedItem } from './FeedItem';
import { useCallWorker } from 'hooks/useWorker';
import { CallRelayType } from 'service/worker/type';
import { Article, Nip23 } from 'service/nip/23';
import { useEffect, useState, useRef } from 'react';
import { ProfileAvatar, ProfileName } from 'components/layout/msg/TextMsg';
import { deserializeMetadata, EventSetMetadataContent, WellKnownEventKind, Event } from 'service/api';
import styles from './index.module.scss';

type ArticleListItemProps = {
  article: Article;
  userMap: UserMap;
};

const ArticleListItem = ({ article: a, userMap }: ArticleListItemProps) => (
  <div key={a.eventId} className={styles.aritcleItem}>
    <div className={styles.itemContent}>
      <ProfileAvatar name={a.pubKey} picture={userMap.get(a.pubKey)?.picture} />
      <div className={styles.content}>
        <ProfileName
          name={userMap.get(a.pubKey)?.name}
          createdAt={a.updated_at}
          pk={a.pubKey}
        />
        <BlogFeedItem
          article={a}
          lightingAddress={
            userMap.get(a.pubKey)?.lud06 || userMap.get(a.pubKey)?.lud16
          }
        />
      </div>
    </div>
  </div>
);

export function BlogFeeds() {
  const [userMap, setUserMap] = useState<UserMap>(new Map());
  const [articles, setArticles] = useState<Article[]>([]);

  const { worker, newConn } = useCallWorker({ workerAliasName: 'blogfeed' });
  function handleEvent(event: Event, relayUrl?: string) {
    console.debug('[blogFeed] receive event');
    switch (event.kind) {
      case WellKnownEventKind.set_metadata:
        const metadata: EventSetMetadataContent = deserializeMetadata(
          event.content,
        );
        setUserMap(prev => {
          const newMap = new Map(prev);
          const oldData = newMap.get(event.pubkey);
          if (oldData && oldData.created_at > event.created_at) {
            // the new data is outdated
            return newMap;
          }

          newMap.set(event.pubkey, {
            ...metadata,
            ...{ created_at: event.created_at },
          });
          return newMap;
        });
        break;

      case WellKnownEventKind.long_form:
        const article = Nip23.toArticle(event);
        setArticles(prev => {
          if (prev.map(p => p.eventId).includes(event.id)) return prev;

          const index = prev.findIndex(p => p.id === article.id);
          if (index !== -1) {
            const old = prev[index];
            if (old.updated_at >= article.updated_at) {
              return prev;
            } else {
              return prev.map((p, id) => {
                if (id === index) return article;
                return p;
              });
            }
          }

          // only add un-duplicated and replyTo msg
          const newItems = [...prev, article];
          // sort by timestamp in asc
          const sortedItems = newItems.sort((a, b) =>
            a.updated_at >= b.updated_at ? -1 : 1,
          );
          return sortedItems;
        });
        break;

      default:
        break;
    }
  }

  useEffect(() => {
    if (newConn.length === 0) return;

    const filter = Nip23.filter({ overrides: { limit: 50 } });
    const callRelay = {
      type: CallRelayType.batch,
      data: newConn,
    };
    const sub = worker?.subFilter(filter, undefined, 'blogFeeds', callRelay);
    // await new Promise(resolve => setTimeout(resolve, 1000));
    sub?.iterating({ cb: handleEvent });
  }, [newConn, worker]);

  const articlesRef = useRef<Article[]>([]);

  useEffect(() => {
    const prevArticles = articlesRef.current;
    const newArticles = articles.filter(
      article => !prevArticles.map(p => p.eventId).includes(article.eventId),
    );
    console.log('New articles added:', newArticles.length);
    articlesRef.current = articles;

    const pks = newArticles.map(a => a.pubKey);
    if (pks.length === 0) return;

    const callRelay = {
      type: CallRelayType.batch,
      data: newConn,
    };
    const sub = worker?.subMetadata(pks, undefined, 'blogMetadata', callRelay);
    sub?.iterating({ cb: handleEvent });
  }, [articles.length]);

  return (
    <div>
      {articles.map((a, key) => (
        <ArticleListItem key={key} article={a} userMap={userMap} />
      ))}
    </div>
  );
}