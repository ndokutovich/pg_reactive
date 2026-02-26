import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export interface Toast {
  id: number;
  message: string;
  type: 'info' | 'success' | 'error';
}

let nextId = 0;

@Injectable({ providedIn: 'root' })
export class ToastService {
  private toastsSubject = new BehaviorSubject<Toast[]>([]);
  toasts$ = this.toastsSubject.asObservable();

  show(message: string, type: 'info' | 'success' | 'error' = 'info'): void {
    const toast: Toast = { id: ++nextId, message, type };
    this.toastsSubject.next([...this.toastsSubject.value, toast]);
    setTimeout(() => this.remove(toast.id), 3200);
  }

  private remove(id: number): void {
    this.toastsSubject.next(this.toastsSubject.value.filter(t => t.id !== id));
  }
}
