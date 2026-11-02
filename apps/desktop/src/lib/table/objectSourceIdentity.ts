import i18n from "@/i18n";

export interface SourceIdentity {
  connectionId: string;
  database: string;
  schema?: string;
  objectType: string;
  name: string;
}

export interface SourceIdentitySnapshot extends SourceIdentity {
  revision: number;
}

interface SourceState {
  revision: number;
  saving: boolean;
  migrating: boolean;
  frozen: boolean;
}

const states = new Map<string, SourceState>();

function stateFor(identity: SourceIdentity): SourceState {
  const key = JSON.stringify([identity.connectionId, identity.database, identity.schema || identity.database, identity.objectType, identity.name]);
  let state = states.get(key);
  if (!state) {
    state = { revision: 0, saving: false, migrating: false, frozen: false };
    states.set(key, state);
  }
  return state;
}

export function captureSourceIdentity(identity: SourceIdentity): SourceIdentitySnapshot {
  return { ...identity, revision: stateFor(identity).revision };
}

export function assertSourceIdentity(snapshot: SourceIdentitySnapshot): void {
  const state = stateFor(snapshot);
  if (snapshot.revision !== state.revision || state.frozen || state.migrating) throw new Error(i18n.global.t("objects.sourceIdentityChanged"));
}

/** Call only after a user-requested reload succeeds, with the version captured before loading. */
export function renewSourceIdentity(snapshot: SourceIdentitySnapshot): SourceIdentitySnapshot {
  const state = stateFor(snapshot);
  if (snapshot.revision !== state.revision || state.migrating || state.saving) throw new Error(i18n.global.t("objects.sourceIdentityChanged"));
  if (state.frozen) {
    state.revision++;
    state.frozen = false;
  }
  return captureSourceIdentity(snapshot);
}

/** Synchronous with dispatch: no await may occur between this call and starting the save. */
export function beginSourceSave(snapshot: SourceIdentitySnapshot): () => void {
  assertSourceIdentity(snapshot);
  const state = stateFor(snapshot);
  if (state.saving) throw new Error(i18n.global.t("objects.sourceIdentitySaving"));
  state.saving = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.saving = false;
  };
}

/** All affected objects are checked before any is frozen. */
export function freezeSourceIdentities(identities: SourceIdentity[]) {
  const affected = [...new Set(identities.map(stateFor))];
  if (affected.some((state) => state.saving || state.migrating)) throw new Error(i18n.global.t("objects.sourceIdentityBusy"));
  for (const state of affected) state.migrating = true;
  let dispatched = false;
  let finished = false;
  return {
    markDispatched() {
      if (finished || dispatched) return;
      dispatched = true;
      for (const state of affected) {
        state.revision++;
        state.frozen = true;
      }
    },
    cancel() {
      if (dispatched || finished) return;
      finished = true;
      for (const state of affected) state.migrating = false;
    },
    finish() {
      if (finished) return;
      finished = true;
      for (const state of affected) state.migrating = false;
    },
  };
}
