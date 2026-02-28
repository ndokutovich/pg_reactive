import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { apiRest, apiRpc, parseJwt, POLL_INTERVAL, WS_BASE } from '../api';
import { useToast } from './Toast';

function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function showNotification(title, body, toastFn) {
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(title, { body, icon: 'icon.svg', tag: 'wtb-' + Date.now() });
    } catch {
      /* ignore */
    }
  }
  toastFn(title + ': ' + body, 'info');
}

export default function DetailScreen({
  list,
  accessToken,
  onBack,
  onShare,
  onDeleteList,
}) {
  const [items, setItems] = useState([]);
  const [itemName, setItemName] = useState('');
  const [itemQty, setItemQty] = useState('1');
  const toast = useToast();
  const nameInputRef = useRef(null);

  // Refs for polling closure stability
  const itemsRef = useRef(items);
  const knownItemIdsRef = useRef(new Set());
  const suppressRef = useRef(false);
  const suppressTimerRef = useRef(null);
  const pollTimerRef = useRef(null);
  const wsRef = useRef(null);

  // Keep itemsRef in sync
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const myUserId = useMemo(() => {
    const claims = parseJwt(accessToken);
    return claims ? claims.sub : null;
  }, [accessToken]);

  // Detect changes from polled data and fire notifications
  const detectChanges = useCallback(
    (newItems) => {
      const known = knownItemIdsRef.current;
      if (suppressRef.current || known.size === 0) {
        newItems.forEach((it) => known.add(it.id));
        return;
      }

      const oldItems = itemsRef.current;

      newItems.forEach((it) => {
        if (!known.has(it.id)) {
          known.add(it.id);
          if (it.added_by !== myUserId) {
            showNotification(
              'Item added',
              it.name + (it.quantity !== '1' ? ' x' + it.quantity : ''),
              toast
            );
          }
          return;
        }
        const old = oldItems.find((o) => o.id === it.id);
        if (old && old.checked !== it.checked && it.added_by !== myUserId) {
          if (it.checked) {
            showNotification('Item checked off', it.name, toast);
          }
        }
      });
    },
    [myUserId, toast]
  );

  const loadItems = useCallback(async () => {
    if (!list) return;
    try {
      const data = await apiRest(
        'GET',
        'shopping_items?list_id=eq.' + list.id + '&order=checked.asc,created_at.desc',
        undefined,
        accessToken
      );
      const newItems = Array.isArray(data) ? data : [];
      detectChanges(newItems);
      setItems(newItems);
    } catch (err) {
      console.error('Load items failed:', err);
    }
  }, [list, accessToken, detectChanges]);

  // Polling helpers
  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    pollTimerRef.current = setInterval(loadItems, POLL_INTERVAL);
  }, [loadItems, stopPolling]);

  // WebSocket live query connection
  const connectLiveQuery = useCallback(() => {
    if (!list || !accessToken) return;

    apiRpc('subscribe_list_items', { p_list_id: list.id }, accessToken)
      .then(() => {
        const qid = 'items-' + list.id;
        const ws = new WebSocket(WS_BASE + '/ws/' + qid + '?token=' + accessToken);
        wsRef.current = ws;

        ws.onmessage = (evt) => {
          try {
            const msg = JSON.parse(evt.data);
            if (msg.type === 'subscribed') return;
            if (msg.type === 'overflow') { loadItems(); return; }

            setItems(prev => {
              let updated = [...prev];
              if (msg.deleted && msg.deleted.length > 0) {
                const delIds = new Set(msg.deleted.map(d => d.id));
                updated = updated.filter(it => !delIds.has(it.id));
              }
              if (msg.inserted && msg.inserted.length > 0) {
                msg.inserted.forEach(row => {
                  const idx = updated.findIndex(it => it.id === row.id);
                  if (idx >= 0) {
                    updated[idx] = row;
                  } else {
                    updated.unshift(row);
                    knownItemIdsRef.current.add(row.id);
                  }
                });
              }
              return updated;
            });
          } catch (e) {
            console.warn('WS parse error:', e);
          }
        };

        ws.onerror = () => {
          console.warn('WS error, falling back to polling');
          ws.close();
          wsRef.current = null;
          startPolling();
        };

        ws.onopen = () => {
          // Stop polling when WS is connected
          stopPolling();
        };

        ws.onclose = () => {
          if (wsRef.current === ws) {
            wsRef.current = null;
          }
        };
      })
      .catch(err => {
        console.warn('Subscribe RPC failed, using polling:', err);
        startPolling();
      });
  }, [list, accessToken, loadItems, startPolling, stopPolling]);

  // Initial load + request notification permission + connect live query
  useEffect(() => {
    if (!list) return;
    knownItemIdsRef.current.clear();
    requestNotificationPermission();
    loadItems().then(() => connectLiveQuery());

    // Start polling as fallback until WS connects
    startPolling();

    return () => {
      stopPolling();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [list]); // eslint-disable-line react-hooks/exhaustive-deps

  // Suppress notifications temporarily after user actions
  const suppressNotifications = useCallback(() => {
    suppressRef.current = true;
    if (suppressTimerRef.current) clearTimeout(suppressTimerRef.current);
    suppressTimerRef.current = setTimeout(() => {
      suppressRef.current = false;
    }, 3000);
  }, []);

  const handleAddItem = useCallback(
    async (e) => {
      e.preventDefault();
      if (!list) return;
      const name = itemName.trim();
      const qty = itemQty.trim() || '1';
      if (!name) return;

      const body = {
        list_id: list.id,
        name,
        quantity: qty,
        checked: false,
        added_by: myUserId,
      };

      suppressNotifications();

      try {
        const created = await apiRest('POST', 'shopping_items', body, accessToken);
        knownItemIdsRef.current.add(created.id);
        setItems((prev) => prev.some(i => i.id === created.id) ? prev : [created, ...prev]);
        setItemName('');
        setItemQty('1');
        if (nameInputRef.current) nameInputRef.current.focus();
      } catch (err) {
        toast('Failed to add: ' + err.message, 'error');
      }
    },
    [list, itemName, itemQty, myUserId, accessToken, toast, suppressNotifications]
  );

  const toggleItem = useCallback(
    async (id, checked) => {
      // Optimistic update
      setItems((prev) =>
        prev.map((it) => (it.id === id ? { ...it, checked } : it))
      );

      suppressNotifications();

      try {
        await apiRest('PATCH', 'shopping_items?id=eq.' + id, { checked }, accessToken);
      } catch (err) {
        // Rollback
        setItems((prev) =>
          prev.map((it) => (it.id === id ? { ...it, checked: !checked } : it))
        );
        toast('Update failed: ' + err.message, 'error');
      }
    },
    [accessToken, toast, suppressNotifications]
  );

  const deleteItem = useCallback(
    async (id) => {
      // Optimistic removal
      const idx = items.findIndex((it) => it.id === id);
      if (idx === -1) return;
      const prevItems = [...items];

      setItems((prev) => prev.filter((it) => it.id !== id));
      knownItemIdsRef.current.delete(id);

      try {
        await apiRest('DELETE', 'shopping_items?id=eq.' + id, undefined, accessToken);
      } catch (err) {
        // Rollback
        setItems(prevItems);
        knownItemIdsRef.current.add(id);
        toast('Delete failed: ' + err.message, 'error');
      }
    },
    [items, accessToken, toast]
  );

  const unchecked = useMemo(() => items.filter((i) => !i.checked), [items]);
  const checked = useMemo(() => items.filter((i) => i.checked), [items]);
  const total = items.length;
  const doneCount = checked.length;
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  return (
    <div className="screen active">
      {/* Top bar */}
      <div className="detail-bar">
        <button className="btn btn-icon btn-ghost" onClick={onBack} title="Back">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <h1>{list ? list.name : 'List'}</h1>
        <button className="btn btn-icon btn-ghost" onClick={onShare} title="Share">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="18" cy="5" r="3" />
            <circle cx="6" cy="12" r="3" />
            <circle cx="18" cy="19" r="3" />
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
          </svg>
        </button>
        <button className="btn btn-icon btn-danger" onClick={onDeleteList} title="Delete list">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      </div>

      {/* Progress strip */}
      <div className="progress-strip">
        <div className="progress-bar-wrap">
          <div className="progress-bar" style={{ width: pct + '%' }} />
        </div>
        <div className="progress-text">
          {doneCount} / {total}
        </div>
      </div>

      {/* Add item row */}
      <form className="add-item-row" onSubmit={handleAddItem}>
        <input
          type="text"
          className="input"
          placeholder="Add item..."
          required
          maxLength={200}
          value={itemName}
          onChange={(e) => setItemName(e.target.value)}
          ref={nameInputRef}
        />
        <input
          type="text"
          className="input qty-input"
          placeholder="Qty"
          maxLength={10}
          value={itemQty}
          onChange={(e) => setItemQty(e.target.value)}
        />
        <button className="btn btn-primary btn-icon" type="submit" title="Add">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </form>

      {/* Items */}
      <div>
        {total === 0 ? (
          <div className="empty-items">
            <div style={{ fontSize: '40px', opacity: 0.4 }}>{'\uD83D\uDED2'}</div>
            <p>List is empty. Add items above!</p>
          </div>
        ) : (
          <ul className="item-list">
            {unchecked.length > 0 && (
              <>
                <li className="item-separator">To buy ({unchecked.length})</li>
                {unchecked.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    onToggle={toggleItem}
                    onDelete={deleteItem}
                  />
                ))}
              </>
            )}
            {checked.length > 0 && (
              <>
                <li className="item-separator">In cart ({checked.length})</li>
                {checked.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    onToggle={toggleItem}
                    onDelete={deleteItem}
                  />
                ))}
              </>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

const ItemRow = React.memo(function ItemRow({ item, onToggle, onDelete }) {
  const handleChange = useCallback(() => {
    onToggle(item.id, !item.checked);
  }, [item.id, item.checked, onToggle]);

  const handleDelete = useCallback(
    (e) => {
      e.stopPropagation();
      onDelete(item.id);
    },
    [item.id, onDelete]
  );

  return (
    <li className={'item-row' + (item.checked ? ' checked' : '')}>
      <input
        type="checkbox"
        className="item-checkbox"
        checked={item.checked}
        onChange={handleChange}
      />
      <div className="item-info">
        <div className="item-name">{item.name}</div>
      </div>
      <span className="item-qty">x{item.quantity || '1'}</span>
      <button
        className="btn btn-danger item-delete"
        title="Remove"
        onClick={handleDelete}
      >
        {'\u2715'}
      </button>
    </li>
  );
});
