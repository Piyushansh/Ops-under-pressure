import { createContext, useContext } from 'react';
import type { Membership, Team, User } from './types';

export interface AppState {
  user: User;
  memberships: Membership[];
  teams: Team[];
  logout: () => void;
}
export const AppCtx = createContext<AppState | null>(null);
export const useApp = () => {
  const v = useContext(AppCtx);
  if (!v) throw new Error('useApp outside provider');
  return v;
};
export const navigate = (path: string) => {
  window.location.hash = path;
};
