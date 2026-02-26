import React, { useState, useEffect, useCallback, useRef } from 'react';
import { apiRpc } from '../api';
import { useToast } from './Toast';

export default function ListsScreen({ accessToken, userEmail, onOpenList, onLogout }) {
  const [lists, setLists] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newListName, setNewListName] = useState('');
  const [shareCode, setShareCode] = useState('');
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const toast = useToast();
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const loadLists = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiRpc('my_shopping_lists', {}, accessToken);
      if (mountedRef.current) {
        setLists(Array.isArray(data) ? data : []);
      }
    } catch (err) {
      if (mountedRef.current) {
        toast('Failed to load lists: ' + err.message, 'error');
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [accessToken, toast]);

  useEffect(() => {
    loadLists();
  }, [loadLists]);

  const handleCreateList = useCallback(
    async (e) => {
      e.preventDefault();
      const name = newListName.trim();
      if (!name) return;

      setCreating(true);
      try {
        await apiRpc('create_shopping_list', { list_name: name }, accessToken);
        setNewListName('');
        toast('List created!', 'success');
        loadLists();
      } catch (err) {
        toast('Failed: ' + err.message, 'error');
      } finally {
        setCreating(false);
      }
    },
    [newListName, accessToken, toast, loadLists]
  );

  const handleJoinList = useCallback(
    async (e) => {
      e.preventDefault();
      const code = shareCode.trim();
      if (!code) return;

      setJoining(true);
      try {
        const data = await apiRpc('join_shopping_list', { code }, accessToken);
        setShareCode('');
        toast('Joined list: ' + (data.name || 'Success'), 'success');
        loadLists();
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        setJoining(false);
      }
    },
    [shareCode, accessToken, toast, loadLists]
  );

  return (
    <div className="screen active">
      <div className="app-bar">
        <h1>{'\uD83D\uDED2'} What to Buy</h1>
        <div className="app-bar-right">
          <span className="user-email">{userEmail}</span>
          <button className="btn btn-ghost" onClick={onLogout}>
            Log out
          </button>
        </div>
      </div>

      <div className="main-pad">
        <div className="section-label">Create New List</div>
        <form className="action-row" onSubmit={handleCreateList}>
          <input
            type="text"
            className="input"
            placeholder="e.g. Weekly groceries"
            required
            maxLength={100}
            value={newListName}
            onChange={(e) => setNewListName(e.target.value)}
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={creating}
          >
            Create
          </button>
        </form>

        <div className="section-label">Join a List</div>
        <form className="action-row" onSubmit={handleJoinList}>
          <input
            type="text"
            className="input"
            placeholder="Enter share code"
            required
            maxLength={10}
            style={{ textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600 }}
            value={shareCode}
            onChange={(e) => setShareCode(e.target.value)}
          />
          <button
            type="submit"
            className="btn btn-secondary"
            disabled={joining}
          >
            Join
          </button>
        </form>

        <div className="section-label">My Lists</div>
        <div>
          {loading ? (
            <div style={{ textAlign: 'center', padding: '20px' }}>
              <div className="spinner" />
            </div>
          ) : lists.length === 0 ? (
            <div className="empty-lists">
              <div style={{ fontSize: '40px', opacity: 0.4 }}>{'\uD83D\uDCCB'}</div>
              <p>No lists yet. Create one or join with a share code!</p>
            </div>
          ) : (
            lists.map((list) => (
              <div
                key={list.id}
                className="list-card"
                onClick={() => onOpenList(list)}
              >
                <div className="list-card-icon">{'\uD83D\uDED2'}</div>
                <div className="list-card-info">
                  <div className="list-card-name">{list.name}</div>
                  <div className="list-card-meta">
                    <span>{'\uD83D\uDC65'} {list.member_count}</span>
                    <span>Code: {(list.share_code || '').toUpperCase()}</span>
                  </div>
                </div>
                <div className="list-card-progress">
                  {list.checked_count}/{list.item_count}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="app-footer">
          Built with pgStack &mdash; PostgreSQL + Rust + Row Level Security
        </div>
      </div>
    </div>
  );
}
