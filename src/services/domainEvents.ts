export interface DomainChangeEvent {
  domain: 'documents' | 'tasks' | 'crm' | 'forms';
  entityType: string;
  entityId: string;
  operation: 'created' | 'updated' | 'deleted';
  revision: string;
  operationId?: string;
}

type DomainChangeListener = (event: DomainChangeEvent) => void;

const listeners = new Set<DomainChangeListener>();

/** Subscribe once at application initialization. Returns an unsubscribe callback. */
export function subscribeToDomainChanges(listener: DomainChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Called by domain services only after their transaction has committed. */
export function emitDomainChange(event: DomainChangeEvent): void {
  listeners.forEach((listener) => listener(event));
}

export function clearDomainChangeSubscribersForTests(): void {
  listeners.clear();
}
