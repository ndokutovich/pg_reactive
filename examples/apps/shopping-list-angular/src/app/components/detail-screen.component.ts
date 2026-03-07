import { Component, EventEmitter, Input, Output, OnInit, OnDestroy, signal, ChangeDetectionStrategy, NgZone } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, WS_BASE } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { ToastService } from '../services/toast.service';
import { ShoppingList } from './lists-screen.component';
import { ShareModalComponent } from './share-modal.component';

interface ShoppingItem {
  id: number;
  list_id: number;
  name: string;
  quantity: string;
  checked: boolean;
  added_by: string | null;
  created_at: string;
}

@Component({
  selector: 'app-detail-screen',
  standalone: true,
  imports: [FormsModule, ShareModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="screen-animate">
      <div class="detail-bar">
        <button class="btn btn-icon btn-ghost" title="Back" (click)="goBack()">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <h1>{{ list?.name }}</h1>
        <button class="btn btn-icon btn-ghost" title="Share" (click)="showShareModal.set(true)">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
        </button>
        <button class="btn btn-icon btn-danger" title="Delete list" (click)="deleteList()">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>

      <div class="progress-strip">
        <div class="progress-bar-wrap">
          <div class="progress-bar" [style.width]="progressPct() + '%'"></div>
        </div>
        <div class="progress-text">{{ checkedCount() }} / {{ totalCount() }}</div>
      </div>

      <form class="add-item-row" (ngSubmit)="addItem()">
        <input
          type="text"
          class="input"
          placeholder="Add item..."
          required
          maxlength="200"
          [(ngModel)]="newItemName"
          name="itemName">
        <input
          type="text"
          class="input qty-input"
          placeholder="Qty"
          maxlength="10"
          [(ngModel)]="newItemQty"
          name="itemQty">
        <button type="submit" class="btn btn-primary btn-icon" title="Add">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
      </form>

      @if (items().length === 0) {
        <div class="empty-items">
          <div style="font-size:40px; opacity:0.4;">{{ cartIcon }}</div>
          <p>List is empty. Add items above!</p>
        </div>
      } @else {
        <ul class="item-list">
          @if (uncheckedItems().length > 0) {
            <li class="item-separator">To buy ({{ uncheckedItems().length }})</li>
            @for (item of uncheckedItems(); track item.id) {
              <li class="item-row">
                <input
                  type="checkbox"
                  class="item-checkbox"
                  [checked]="item.checked"
                  (change)="toggleItem(item.id, true)">
                <div class="item-info">
                  <div class="item-name">{{ item.name }}</div>
                </div>
                <span class="item-qty">x{{ item.quantity || '1' }}</span>
                <button class="btn btn-danger item-delete" title="Remove" (click)="deleteItem(item.id)">✕</button>
              </li>
            }
          }
          @if (checkedItems().length > 0) {
            <li class="item-separator">In cart ({{ checkedItems().length }})</li>
            @for (item of checkedItems(); track item.id) {
              <li class="item-row checked">
                <input
                  type="checkbox"
                  class="item-checkbox"
                  [checked]="item.checked"
                  (change)="toggleItem(item.id, false)">
                <div class="item-info">
                  <div class="item-name">{{ item.name }}</div>
                </div>
                <span class="item-qty">x{{ item.quantity || '1' }}</span>
                <button class="btn btn-danger item-delete" title="Remove" (click)="deleteItem(item.id)">✕</button>
              </li>
            }
          }
        </ul>
      }
    </div>

    @if (showShareModal()) {
      <app-share-modal
        [shareCode]="(list?.share_code || '').toUpperCase()"
        [listName]="list?.name || ''"
        (closed)="showShareModal.set(false)">
      </app-share-modal>
    }
  `
})
export class DetailScreenComponent implements OnInit, OnDestroy {
  @Input() list: ShoppingList | null = null;
  @Output() back = new EventEmitter<void>();
  cartIcon = '\uD83D\uDED2';

  items = signal<ShoppingItem[]>([]);
  showShareModal = signal(false);
  newItemName = '';
  newItemQty = '1';

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private knownItemIds = new Set<number>();
  private suppressNotifications = false;
  private ws: WebSocket | null = null;

  uncheckedItems = signal<ShoppingItem[]>([]);
  checkedItems = signal<ShoppingItem[]>([]);
  totalCount = signal(0);
  checkedCount = signal(0);
  progressPct = signal(0);

  constructor(
    private api: ApiService,
    private auth: AuthService,
    private toast: ToastService,
    private ngZone: NgZone
  ) {}

  ngOnInit(): void {
    this.knownItemIds.clear();
    this.loadItems().then(() => this.connectLiveQuery());
    this.startPolling(); // Will be stopped when WS connects
  }

  ngOnDestroy(): void {
    this.stopPolling();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  goBack(): void {
    this.stopPolling();
    if (this.ws) { this.ws.close(); this.ws = null; }
    this.back.emit();
  }

  private connectLiveQuery(): void {
    if (!this.list) return;
    const token = this.auth.getToken();
    if (!token) return;

    this.api.apiRpc('subscribe_list_items', { p_list_id: this.list.id })
      .then(() => {
        const qid = 'items-' + this.list!.id;
        const currentToken = this.auth.getToken();
        const ws = new WebSocket(WS_BASE + '/ws/' + qid + '?token=' + currentToken);
        this.ws = ws;

        ws.onmessage = (evt: MessageEvent) => {
          this.ngZone.run(() => {
            try {
              const msg = JSON.parse(evt.data);
              if (msg.type === 'subscribed') return;
              if (msg.type === 'overflow') { this.loadItems(); return; }

              let current = [...this.items()];
              const insertedIds = new Set((msg.inserted || []).map((r: { id: string }) => r.id));

              // Process inserted first (upsert)
              if (msg.inserted && msg.inserted.length > 0) {
                msg.inserted.forEach((row: ShoppingItem) => {
                  const idx = current.findIndex(it => it.id === row.id);
                  if (idx >= 0) {
                    current[idx] = row;
                  } else {
                    current.unshift(row);
                    this.knownItemIds.add(row.id);
                  }
                });
              }
              // Process deleted (skip ids also in inserted — those are updates)
              if (msg.deleted && msg.deleted.length > 0) {
                const delIds = new Set(msg.deleted.filter((d: { id: string }) => !insertedIds.has(d.id)).map((d: { id: string }) => d.id));
                if (delIds.size > 0) {
                  current = current.filter(it => !delIds.has(it.id));
                }
              }

              this.items.set(current);
              this.updateDerived(current);
            } catch (e) {
              console.warn('WS parse error:', e);
            }
          });
        };

        ws.onerror = () => {
          console.warn('WS error, falling back to polling');
          ws.close();
          this.ws = null;
          this.startPolling();
        };

        ws.onopen = () => {
          this.stopPolling();
        };

        ws.onclose = () => {
          if (this.ws === ws) this.ws = null;
        };
      })
      .catch((err: unknown) => {
        console.warn('Subscribe RPC failed, using polling:', err);
      });
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => this.loadItems(), 2000);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async loadItems(): Promise<void> {
    if (!this.list) return;
    try {
      const data = await this.api.apiRest<ShoppingItem[]>(
        'GET',
        'shopping_items?list_id=eq.' + this.list.id + '&order=checked.asc,created_at.desc'
      );
      const newItems = Array.isArray(data) ? data : [];
      this.detectChanges(newItems);
      this.items.set(newItems);
      this.updateDerived(newItems);
    } catch (err) {
      console.error('Load items failed:', err);
    }
  }

  private updateDerived(allItems: ShoppingItem[]): void {
    const unchecked = allItems.filter(i => !i.checked);
    const checked = allItems.filter(i => i.checked);
    this.uncheckedItems.set(unchecked);
    this.checkedItems.set(checked);
    this.totalCount.set(allItems.length);
    this.checkedCount.set(checked.length);
    this.progressPct.set(allItems.length > 0 ? Math.round(checked.length / allItems.length * 100) : 0);
  }

  private detectChanges(newItems: ShoppingItem[]): void {
    if (this.suppressNotifications || this.knownItemIds.size === 0) {
      newItems.forEach(it => this.knownItemIds.add(it.id));
      return;
    }

    const token = this.auth.getToken();
    const claims = token ? this.auth.parseJwt(token) : null;
    const myUserId = claims ? (claims['sub'] as string) : null;
    const oldItems = this.items();

    newItems.forEach(it => {
      if (!this.knownItemIds.has(it.id)) {
        this.knownItemIds.add(it.id);
        if (it.added_by !== myUserId) {
          this.showNotification('Item added', it.name + (it.quantity !== '1' ? ' x' + it.quantity : ''));
        }
        return;
      }
      const old = oldItems.find(o => o.id === it.id);
      if (old && old.checked !== it.checked && it.added_by !== myUserId) {
        if (it.checked) {
          this.showNotification('Item checked off', it.name);
        }
      }
    });
  }

  private showNotification(title: string, body: string): void {
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(title, { body, icon: 'icon.svg', tag: 'wtb-' + Date.now() });
      } catch { /* ignore */ }
    }
    this.toast.show(title + ': ' + body, 'info');
  }

  async addItem(): Promise<void> {
    if (!this.list) return;
    const name = this.newItemName.trim();
    const qty = this.newItemQty.trim() || '1';
    if (!name) return;

    const token = this.auth.getToken();
    const claims = token ? this.auth.parseJwt(token) : null;

    const body = {
      list_id: this.list.id,
      name,
      quantity: qty,
      checked: false,
      added_by: claims ? claims['sub'] : null
    };

    this.suppressNotifications = true;
    setTimeout(() => { this.suppressNotifications = false; }, 3000);

    try {
      const created = await this.api.apiRest<ShoppingItem>('POST', 'shopping_items', body);
      const current = this.items();
      const exists = current.some(i => i.id === created.id);
      const updated = exists ? current : [created, ...current];
      this.items.set(updated);
      this.knownItemIds.add(created.id);
      this.updateDerived(updated);
      this.newItemName = '';
      this.newItemQty = '1';
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.toast.show('Failed to add: ' + msg, 'error');
    }
  }

  toggleItem(id: number, checked: boolean): void {
    const current = this.items();
    const item = current.find(i => i.id === id);
    if (!item) return;

    const prev = item.checked;
    const updated = current.map(i => i.id === id ? { ...i, checked } : i);
    this.items.set(updated);
    this.updateDerived(updated);

    this.suppressNotifications = true;
    setTimeout(() => { this.suppressNotifications = false; }, 3000);

    this.api.apiRest('PATCH', 'shopping_items?id=eq.' + id, { checked }).catch((err: unknown) => {
      const reverted = this.items().map(i => i.id === id ? { ...i, checked: prev } : i);
      this.items.set(reverted);
      this.updateDerived(reverted);
      const msg = err instanceof Error ? err.message : String(err);
      this.toast.show('Update failed: ' + msg, 'error');
    });
  }

  deleteItem(id: number): void {
    const current = this.items();
    const idx = current.findIndex(i => i.id === id);
    if (idx === -1) return;

    const removed = current[idx];
    const updated = current.filter(i => i.id !== id);
    this.items.set(updated);
    this.knownItemIds.delete(id);
    this.updateDerived(updated);

    this.api.apiRest('DELETE', 'shopping_items?id=eq.' + id).catch((err: unknown) => {
      const reverted = [...this.items()];
      reverted.splice(idx, 0, removed);
      this.items.set(reverted);
      this.knownItemIds.add(id);
      this.updateDerived(reverted);
      const msg = err instanceof Error ? err.message : String(err);
      this.toast.show('Delete failed: ' + msg, 'error');
    });
  }

  deleteList(): void {
    if (!this.list) return;
    if (!confirm('Delete "' + this.list.name + '" and all its items?')) return;

    this.api.apiRest('DELETE', 'shopping_lists?id=eq.' + this.list.id).then(() => {
      this.toast.show('List deleted', 'success');
      this.goBack();
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.toast.show('Delete failed: ' + msg, 'error');
    });
  }
}
