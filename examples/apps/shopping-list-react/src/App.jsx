import React, { useState, useCallback, useEffect, useRef } from 'react';
import { ToastProvider, useToast } from './components/Toast';
import SetupScreen from './components/SetupScreen';
import AuthScreen from './components/AuthScreen';
import ListsScreen from './components/ListsScreen';
import DetailScreen from './components/DetailScreen';
import ShareModal from './components/ShareModal';
import { apiRest, authHeaders, API_BASE, parseJwt, saveSession, loadSession, clearSession, tryRefresh } from './api';

function AppInner() {
  const [screen, setScreen] = useState('setup'); // setup | auth | lists | detail
  const [accessToken, setAccessToken] = useState(null);
  const [currentUser, setCurrentUser] = useState(null);
  const [currentList, setCurrentList] = useState(null);
  const [shareModalVisible, setShareModalVisible] = useState(false);
  const toast = useToast();

  // Ref to avoid stale closure in hash dispatch
  const currentListRef = useRef(null);
  useEffect(() => {
    currentListRef.current = currentList;
  }, [currentList]);

  // Hash routing helper
  const navigate = useCallback((path) => {
    location.hash = '#/' + path;
  }, []);

  // Register service worker on mount
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch((err) => {
        console.log('SW registration failed:', err);
      });
    }
  }, []);

  // Session persistence on mount
  useEffect(() => {
    const session = loadSession();
    if (!session || !session.access_token) return;

    const claims = parseJwt(session.access_token);
    if (!claims) { clearSession(); return; }

    // Check if token is expired
    if (claims.exp && claims.exp * 1000 < Date.now()) {
      // Try refresh
      tryRefresh().then(data => {
        if (data) {
          setAccessToken(data.access_token);
          setCurrentUser(data.user);
          if (!location.hash || location.hash === '#/' || location.hash === '#/setup' || location.hash === '#/auth') {
            navigate('lists');
          }
        }
      });
    } else {
      setAccessToken(session.access_token);
      setCurrentUser(session.user);
      if (!location.hash || location.hash === '#/' || location.hash === '#/setup' || location.hash === '#/auth') {
        navigate('lists');
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Hash-based routing
  useEffect(() => {
    function dispatch() {
      const hash = location.hash || '#/setup';
      const parts = hash.slice(2).split('/');
      const route = parts[0] || 'setup';

      if (route === 'setup') setScreen('setup');
      else if (route === 'auth') setScreen('auth');
      else if (route === 'lists') setScreen('lists');
      else if (route === 'list' && parts[1]) {
        const listId = parseInt(parts[1]);
        // If we already have this list loaded, just show detail
        if (currentListRef.current && currentListRef.current.id === listId) {
          setScreen('detail');
        } else {
          // Deep-link: need to fetch list info
          const session = loadSession();
          if (session && session.access_token) {
            apiRest('GET', 'shopping_lists?id=eq.' + listId + '&select=*', undefined, session.access_token)
              .then(data => {
                if (Array.isArray(data) && data.length > 0) {
                  setCurrentList(data[0]);
                  setScreen('detail');
                } else {
                  navigate('lists');
                }
              }).catch(() => navigate('lists'));
          } else {
            navigate('auth');
          }
        }
      } else {
        setScreen('setup');
      }
    }

    window.addEventListener('hashchange', dispatch);
    dispatch();
    return () => window.removeEventListener('hashchange', dispatch);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Visibility change: refresh token if expired when tab becomes visible
  useEffect(() => {
    function handleVisibility() {
      if (document.visibilityState === 'visible' && accessToken) {
        const claims = parseJwt(accessToken);
        if (claims && claims.exp && claims.exp * 1000 < Date.now()) {
          tryRefresh().then(data => {
            if (data) {
              setAccessToken(data.access_token);
              setCurrentUser(data.user);
            }
          });
        }
      }
    }
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [accessToken]);

  const handleSetupComplete = useCallback(() => {
    navigate('auth');
  }, [navigate]);

  const handleLogin = useCallback((token, user, refreshToken) => {
    setAccessToken(token);
    setCurrentUser(user);
    saveSession({ access_token: token, refresh_token: refreshToken, user });
    navigate('lists');
  }, [navigate]);

  const handleOpenList = useCallback((list) => {
    setCurrentList(list);
    navigate('list/' + list.id);
  }, [navigate]);

  const handleBackToLists = useCallback(() => {
    setCurrentList(null);
    navigate('lists');
  }, [navigate]);

  const handleLogout = useCallback(() => {
    if (accessToken) {
      fetch(API_BASE + '/auth/v1/logout', {
        method: 'POST',
        headers: authHeaders(accessToken),
      }).catch(() => {});
    }
    setAccessToken(null);
    setCurrentUser(null);
    setCurrentList(null);
    clearSession();
    navigate('auth');
  }, [accessToken, navigate]);

  const handleShareOpen = useCallback(() => {
    setShareModalVisible(true);
  }, []);

  const handleShareClose = useCallback(() => {
    setShareModalVisible(false);
  }, []);

  const handleDeleteList = useCallback(async () => {
    if (!currentList) return;
    if (!window.confirm('Delete "' + currentList.name + '" and all its items?')) return;

    try {
      await apiRest('DELETE', 'shopping_lists?id=eq.' + currentList.id, undefined, accessToken);
      toast('List deleted', 'success');
      handleBackToLists();
    } catch (err) {
      toast('Delete failed: ' + err.message, 'error');
    }
  }, [currentList, accessToken, toast, handleBackToLists]);

  return (
    <>
      {screen === 'setup' && <SetupScreen onComplete={handleSetupComplete} />}
      {screen === 'auth' && <AuthScreen onLogin={handleLogin} />}
      {screen === 'lists' && (
        <ListsScreen
          accessToken={accessToken}
          userEmail={currentUser ? currentUser.email : ''}
          onOpenList={handleOpenList}
          onLogout={handleLogout}
        />
      )}
      {screen === 'detail' && (
        <DetailScreen
          list={currentList}
          accessToken={accessToken}
          onBack={handleBackToLists}
          onShare={handleShareOpen}
          onDeleteList={handleDeleteList}
        />
      )}
      <ShareModal
        visible={shareModalVisible}
        list={currentList}
        onClose={handleShareClose}
      />
    </>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AppInner />
    </ToastProvider>
  );
}
