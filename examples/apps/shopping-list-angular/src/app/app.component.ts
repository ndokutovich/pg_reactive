import { Component, signal } from '@angular/core';
import { ToastComponent } from './components/toast.component';
import { SetupScreenComponent } from './components/setup-screen.component';
import { AuthScreenComponent } from './components/auth-screen.component';
import { ListsScreenComponent } from './components/lists-screen.component';
import { DetailScreenComponent } from './components/detail-screen.component';
import { ShoppingList } from './components/lists-screen.component';
import { ApiService } from './services/api.service';
import { AuthService } from './services/auth.service';

type Screen = 'setup' | 'auth' | 'lists' | 'detail';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    ToastComponent,
    SetupScreenComponent,
    AuthScreenComponent,
    ListsScreenComponent,
    DetailScreenComponent
  ],
  templateUrl: './app.component.html'
})
export class AppComponent {
  screen = signal<Screen>('setup');
  currentList = signal<ShoppingList | null>(null);

  constructor(private auth: AuthService, private api: ApiService) {
    this.registerServiceWorker();

    // Restore session
    const restored = this.auth.restoreSession();
    if (restored) {
      if (!location.hash || location.hash === '#/' || location.hash === '#/setup' || location.hash === '#/auth') {
        this.navigate('lists');
      }
    }

    // Hash routing
    window.addEventListener('hashchange', () => this.dispatch());
    this.dispatch();

    // Visibility change
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.auth.refreshIfNeeded();
      }
    });
  }

  navigate(path: string): void {
    location.hash = '#/' + path;
  }

  private dispatch(): void {
    const hash = location.hash || '#/setup';
    const parts = hash.slice(2).split('/');
    const route = parts[0] || 'setup';

    if (route === 'setup') this.screen.set('setup');
    else if (route === 'auth') this.screen.set('auth');
    else if (route === 'lists') this.screen.set('lists');
    else if (route === 'list' && parts[1]) {
      const listId = parseInt(parts[1]);
      const current = this.currentList();
      if (current && current.id === listId) {
        this.screen.set('detail');
      } else if (this.auth.getToken()) {
        this.api.apiRest<any[]>('GET', 'shopping_lists?id=eq.' + listId + '&select=*')
          .then(data => {
            if (Array.isArray(data) && data.length > 0) {
              this.currentList.set(data[0]);
              this.screen.set('detail');
            } else {
              this.navigate('lists');
            }
          }).catch(() => this.navigate('lists'));
      } else {
        this.navigate('auth');
      }
    } else {
      this.screen.set('setup');
    }
  }

  onAuthenticated(): void {
    this.navigate('lists');
  }

  onOpenList(list: ShoppingList): void {
    this.currentList.set(list);
    this.navigate('list/' + list.id);
  }

  onBackToLists(): void {
    this.currentList.set(null);
    this.navigate('lists');
  }

  onLoggedOut(): void {
    this.currentList.set(null);
    this.navigate('auth');
  }

  private registerServiceWorker(): void {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(err => {
        console.log('SW registration failed:', err);
      });
    }
  }
}
