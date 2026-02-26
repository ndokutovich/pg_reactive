import { Component, EventEmitter, Output, OnInit, signal, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AsyncPipe } from '@angular/common';
import { ApiService } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { ToastService } from '../services/toast.service';

export interface ShoppingList {
  id: number;
  name: string;
  share_code: string;
  owner_id: string;
  member_count: number;
  item_count: number;
  checked_count: number;
  created_at: string;
}

@Component({
  selector: 'app-lists-screen',
  standalone: true,
  imports: [FormsModule, AsyncPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="screen-animate">
      <div class="app-bar">
        <h1>{{ cartIcon }} What to Buy</h1>
        <div class="app-bar-right">
          <span class="user-email">{{ (auth.user$ | async)?.email }}</span>
          <button class="btn btn-ghost" (click)="handleLogout()">Log out</button>
        </div>
      </div>
      <div class="main-pad">
        <div class="section-label">Create New List</div>
        <form class="action-row" (ngSubmit)="createList()">
          <input
            type="text"
            class="input"
            placeholder="e.g. Weekly groceries"
            required
            maxlength="100"
            [(ngModel)]="newListName"
            name="listName">
          <button
            type="submit"
            class="btn btn-primary"
            [disabled]="creating()">
            Create
          </button>
        </form>

        <div class="section-label">Join a List</div>
        <form class="action-row" (ngSubmit)="joinList()">
          <input
            type="text"
            class="input"
            placeholder="Enter share code"
            required
            maxlength="10"
            style="text-transform:uppercase; letter-spacing:0.1em; font-weight:600;"
            [(ngModel)]="shareCodeInput"
            name="shareCode">
          <button
            type="submit"
            class="btn btn-secondary"
            [disabled]="joining()">
            Join
          </button>
        </form>

        <div class="section-label">My Lists</div>
        @if (loadingLists()) {
          <div style="text-align:center; padding:20px;">
            <div class="spinner"></div>
          </div>
        } @else if (lists().length === 0) {
          <div class="empty-lists">
            <div style="font-size:40px; opacity:0.4;">{{ clipboardIcon }}</div>
            <p>No lists yet. Create one or join with a share code!</p>
          </div>
        } @else {
          @for (list of lists(); track list.id) {
            <div class="list-card" (click)="openList.emit(list)">
              <div class="list-card-icon">{{ cartIcon }}</div>
              <div class="list-card-info">
                <div class="list-card-name">{{ list.name }}</div>
                <div class="list-card-meta">
                  <span>{{ peopleIcon }} {{ list.member_count }}</span>
                  <span>Code: {{ (list.share_code || '').toUpperCase() }}</span>
                </div>
              </div>
              <div class="list-card-progress">{{ list.checked_count }}/{{ list.item_count }}</div>
            </div>
          }
        }

        <div class="app-footer">
          Built with pgStack — PostgreSQL + Rust + Row Level Security
        </div>
      </div>
    </div>
  `
})
export class ListsScreenComponent implements OnInit {
  @Output() openList = new EventEmitter<ShoppingList>();
  @Output() loggedOut = new EventEmitter<void>();
  cartIcon = '\uD83D\uDED2';
  clipboardIcon = '\uD83D\uDCCB';
  peopleIcon = '\uD83D\uDC65';

  lists = signal<ShoppingList[]>([]);
  loadingLists = signal(false);
  creating = signal(false);
  joining = signal(false);
  newListName = '';
  shareCodeInput = '';

  constructor(
    private api: ApiService,
    public auth: AuthService,
    private toast: ToastService
  ) {}

  ngOnInit(): void {
    this.requestNotificationPermission();
    this.loadLists();
  }

  async loadLists(): Promise<void> {
    this.loadingLists.set(true);
    try {
      const data = await this.api.apiRpc<ShoppingList[]>('my_shopping_lists');
      this.lists.set(Array.isArray(data) ? data : []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.toast.show('Failed to load lists: ' + msg, 'error');
    } finally {
      this.loadingLists.set(false);
    }
  }

  async createList(): Promise<void> {
    const name = this.newListName.trim();
    if (!name) return;

    this.creating.set(true);
    try {
      await this.api.apiRpc('create_shopping_list', { list_name: name });
      this.newListName = '';
      this.toast.show('List created!', 'success');
      await this.loadLists();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.toast.show('Failed: ' + msg, 'error');
    } finally {
      this.creating.set(false);
    }
  }

  async joinList(): Promise<void> {
    const code = this.shareCodeInput.trim();
    if (!code) return;

    this.joining.set(true);
    try {
      const data = await this.api.apiRpc<{ name?: string }>('join_shopping_list', { code });
      this.shareCodeInput = '';
      this.toast.show('Joined list: ' + (data?.name || 'Success'), 'success');
      await this.loadLists();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.toast.show(msg, 'error');
    } finally {
      this.joining.set(false);
    }
  }

  handleLogout(): void {
    this.auth.logout();
    this.loggedOut.emit();
  }

  private requestNotificationPermission(): void {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }
}
