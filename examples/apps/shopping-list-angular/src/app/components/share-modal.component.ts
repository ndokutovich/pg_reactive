import { Component, EventEmitter, Input, Output, signal, ChangeDetectionStrategy } from '@angular/core';

@Component({
  selector: 'app-share-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="modal-overlay" (click)="onOverlayClick($event)">
      <div class="modal-box">
        <h3>Share This List</h3>
        <p>Give this code to your partner so they can join the list.</p>
        <div class="share-code-display">{{ shareCode }}</div>
        @if (copyFeedback()) {
          <div class="copy-feedback">{{ copyFeedback() }}</div>
        } @else {
          <div class="copy-feedback"></div>
        }
        <button class="btn btn-primary btn-full" (click)="copyCode()">Copy Code</button>
        @if (hasNativeShare) {
          <button class="btn btn-ghost btn-full" style="margin-top:8px;" (click)="nativeShare()">Share via...</button>
        }
        <button class="btn btn-ghost btn-full" style="margin-top:8px;" (click)="closed.emit()">Close</button>
      </div>
    </div>
  `
})
export class ShareModalComponent {
  @Input() shareCode = '';
  @Input() listName = '';
  @Output() closed = new EventEmitter<void>();

  copyFeedback = signal('');
  hasNativeShare = typeof navigator !== 'undefined' && !!navigator.share;

  onOverlayClick(event: MouseEvent): void {
    if ((event.target as HTMLElement).classList.contains('modal-overlay')) {
      this.closed.emit();
    }
  }

  copyCode(): void {
    navigator.clipboard.writeText(this.shareCode).then(() => {
      this.copyFeedback.set('Copied!');
    }).catch(() => {
      this.copyFeedback.set('Copy failed -- select and copy manually');
    });
  }

  nativeShare(): void {
    if (!navigator.share) return;
    navigator.share({
      title: 'Join my shopping list: ' + this.listName,
      text: 'Use code ' + this.shareCode + ' to join my shopping list on What to Buy!'
    }).catch(() => { /* user cancelled */ });
  }
}
