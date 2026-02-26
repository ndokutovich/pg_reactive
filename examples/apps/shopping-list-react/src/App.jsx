import React, { useState, useCallback, useEffect } from 'react';
import { ToastProvider, useToast } from './components/Toast';
import SetupScreen from './components/SetupScreen';
import AuthScreen from './components/AuthScreen';
import ListsScreen from './components/ListsScreen';
import DetailScreen from './components/DetailScreen';
import ShareModal from './components/ShareModal';
import { apiRest, authHeaders, API_BASE } from './api';

function AppInner() {
  const [screen, setScreen] = useState('setup'); // setup | auth | lists | detail
  const [accessToken, setAccessToken] = useState(null);
  const [currentUser, setCurrentUser] = useState(null);
  const [currentList, setCurrentList] = useState(null);
  const [shareModalVisible, setShareModalVisible] = useState(false);
  const toast = useToast();

  // Register service worker on mount
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch((err) => {
        console.log('SW registration failed:', err);
      });
    }
  }, []);

  const handleSetupComplete = useCallback(() => {
    setScreen('auth');
  }, []);

  const handleLogin = useCallback((token, user) => {
    setAccessToken(token);
    setCurrentUser(user);
    setScreen('lists');
  }, []);

  const handleOpenList = useCallback((list) => {
    setCurrentList(list);
    setScreen('detail');
  }, []);

  const handleBackToLists = useCallback(() => {
    setCurrentList(null);
    setScreen('lists');
  }, []);

  const handleLogout = useCallback(() => {
    // Fire-and-forget logout request
    if (accessToken) {
      fetch(API_BASE + '/auth/v1/logout', {
        method: 'POST',
        headers: authHeaders(accessToken),
      }).catch(() => {});
    }

    setAccessToken(null);
    setCurrentUser(null);
    setCurrentList(null);
    setScreen('auth');
  }, [accessToken]);

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
