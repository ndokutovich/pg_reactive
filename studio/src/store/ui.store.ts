import { create } from 'zustand';

interface UiState {
  theme: 'dark' | 'light';
  toggleTheme: () => void;
}

export const useUiStore = create<UiState>()((set, get) => ({
  theme: 'dark',
  toggleTheme: () => {
    const next = get().theme === 'dark' ? 'light' : 'dark';
    set({ theme: next });
    if (next === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  },
}));
