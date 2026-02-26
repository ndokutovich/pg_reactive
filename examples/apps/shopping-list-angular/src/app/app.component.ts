import { Component, signal } from '@angular/core';
import { ToastComponent } from './components/toast.component';
import { SetupScreenComponent } from './components/setup-screen.component';
import { AuthScreenComponent } from './components/auth-screen.component';
import { ListsScreenComponent } from './components/lists-screen.component';
import { DetailScreenComponent } from './components/detail-screen.component';
import { ShoppingList } from './components/lists-screen.component';

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

  constructor() {
    this.registerServiceWorker();
  }

  onAuthenticated(): void {
    this.screen.set('lists');
  }

  onOpenList(list: ShoppingList): void {
    this.currentList.set(list);
    this.screen.set('detail');
  }

  onBackToLists(): void {
    this.currentList.set(null);
    this.screen.set('lists');
  }

  onLoggedOut(): void {
    this.currentList.set(null);
    this.screen.set('auth');
  }

  private registerServiceWorker(): void {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(err => {
        console.log('SW registration failed:', err);
      });
    }
  }
}
