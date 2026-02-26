import { Component, ChangeDetectionStrategy } from '@angular/core';
import { AsyncPipe } from '@angular/common';
import { ToastService } from '../services/toast.service';

@Component({
  selector: 'app-toast',
  standalone: true,
  imports: [AsyncPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="toast-area">
      @for (toast of (toastService.toasts$ | async) ?? []; track toast.id) {
        <div class="toast" [class]="'toast toast-' + toast.type">
          {{ toast.message }}
        </div>
      }
    </div>
  `
})
export class ToastComponent {
  constructor(public toastService: ToastService) {}
}
