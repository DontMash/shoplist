import { create } from 'zustand';
import { uid } from '../lib/list';
import { readStorage, writeStorage } from './storage';

export interface ParticipantIdentity {
  clientId: string;
  name: string;
}

interface ParticipantStore {
  identity: ParticipantIdentity;
  setName: (name: string) => void;
}

function initialIdentity(): ParticipantIdentity {
  const storedClientId = readStorage<unknown>('sl.client', null);
  const storedName = readStorage<unknown>('sl.name', '');
  const clientId = typeof storedClientId === 'string' && storedClientId ? storedClientId : uid();
  const name = typeof storedName === 'string' ? storedName : '';
  writeStorage('sl.client', clientId);
  return { clientId, name };
}

export const useParticipantStore = create<ParticipantStore>((set) => ({
  identity: initialIdentity(),
  setName: (name) => set((state) => {
    const identity = { ...state.identity, name };
    writeStorage('sl.name', name);
    writeStorage('sl.client', identity.clientId);
    return { identity };
  }),
}));
