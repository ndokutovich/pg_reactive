import { Component, EventEmitter, Output, signal, ChangeDetectionStrategy } from '@angular/core';
import { ApiService } from '../services/api.service';
import { MIGRATION_SQL } from '../migration';

interface LogEntry {
  text: string;
  cls: string;
}

@Component({
  selector: 'app-setup-screen',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="screen-animate">
      <div class="setup-hero card">
        <div class="card-body">
          <div class="setup-icon">{{ cartIcon }}</div>
          <h1>What to Buy</h1>
          <p>A shared shopping list for couples. Set up the database to get started.</p>
          <button
            class="btn btn-primary btn-full"
            [disabled]="running()"
            (click)="runSetup()">
            {{ buttonText() }}
          </button>
          <button
            class="btn btn-ghost btn-full setup-skip"
            (click)="skip.emit()">
            Skip (already set up)
          </button>
          @if (logEntries().length > 0) {
            <div class="setup-log">
              @for (entry of logEntries(); track $index) {
                <div [class]="entry.cls">{{ entry.text }}</div>
              }
            </div>
          }
        </div>
      </div>
    </div>
  `
})
export class SetupScreenComponent {
  @Output() skip = new EventEmitter<void>();
  @Output() done = new EventEmitter<void>();
  cartIcon = '\uD83D\uDED2';

  running = signal(false);
  buttonText = signal('Setup Database');
  logEntries = signal<LogEntry[]>([]);

  constructor(private api: ApiService) {}

  async runSetup(): Promise<void> {
    this.running.set(true);
    this.buttonText.set('Setting up...');
    this.logEntries.set([]);

    let allOk = true;

    for (let i = 0; i < MIGRATION_SQL.length; i++) {
      const stmt = MIGRATION_SQL[i];
      let short = stmt.replace(/\n/g, ' ');
      if (short.length > 60) short = short.substring(0, 60) + '...';
      this.appendLog('> ' + short, '');

      try {
        const result = await this.api.apiSql(stmt);
        if (result.error) {
          if (result.error.indexOf('already exists') !== -1 || result.error.indexOf('duplicate') !== -1) {
            this.appendLog('  (skipped)', 'ok');
          } else {
            this.appendLog('  ERROR: ' + result.error, 'error');
            allOk = false;
          }
        } else {
          this.appendLog('  OK', 'ok');
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.appendLog('  NETWORK ERROR: ' + msg, 'error');
        allOk = false;
      }
    }

    if (allOk) {
      this.appendLog('\nSetup complete! Proceeding to sign in...', 'ok');
      this.appendLog('NOTE: If REST calls fail, restart proxy: docker compose restart proxy', 'ok');
      this.buttonText.set('Done!');
      setTimeout(() => this.done.emit(), 1200);
    } else {
      this.appendLog('\nSetup finished with errors. You may retry.', 'error');
      this.running.set(false);
      this.buttonText.set('Retry Setup');
    }
  }

  private appendLog(text: string, cls: string): void {
    this.logEntries.update(entries => [...entries, { text, cls }]);
  }
}
