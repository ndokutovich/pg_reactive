import React, { useState, useCallback, useMemo } from 'react';

export default function ShareModal({ visible, list, onClose }) {
  const [copyFeedback, setCopyFeedback] = useState('');

  const code = useMemo(
    () => (list && list.share_code ? list.share_code.toUpperCase() : '------'),
    [list]
  );

  const canNativeShare = typeof navigator !== 'undefined' && !!navigator.share;

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(
      () => setCopyFeedback('Copied!'),
      () => setCopyFeedback('Copy failed \u2014 select and copy manually')
    );
  }, [code]);

  const handleNativeShare = useCallback(() => {
    if (!list || !navigator.share) return;
    navigator
      .share({
        title: 'Join my shopping list: ' + list.name,
        text:
          'Use code ' +
          code +
          ' to join my shopping list on What to Buy!',
      })
      .catch(() => {
        /* user cancelled */
      });
  }, [list, code]);

  const handleOverlayClick = useCallback(
    (e) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose]
  );

  // Reset feedback when modal reopens
  React.useEffect(() => {
    if (visible) setCopyFeedback('');
  }, [visible]);

  if (!visible) return null;

  return (
    <div className="modal-overlay visible" onClick={handleOverlayClick}>
      <div className="modal-box">
        <h3>Share This List</h3>
        <p>Give this code to your partner so they can join the list.</p>
        <div className="share-code-display">{code}</div>
        <div className="copy-feedback">{copyFeedback}</div>
        <button className="btn btn-primary btn-full" onClick={handleCopy}>
          Copy Code
        </button>
        {canNativeShare && (
          <button
            className="btn btn-ghost btn-full"
            style={{ marginTop: '8px' }}
            onClick={handleNativeShare}
          >
            Share via...
          </button>
        )}
        <button
          className="btn btn-ghost btn-full"
          style={{ marginTop: '8px' }}
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </div>
  );
}
