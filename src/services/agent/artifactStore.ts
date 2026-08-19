import type { AgentArtifact, AgentArtifactKind, AgentEvent } from '../../types/agent';
import { db, type TabsDB } from '../db';
import { generateId } from './helpers';

interface StoredAgentArtifact extends AgentArtifact {
  payload: Uint8Array;
}

export interface PutArtifactInput {
  id?: string;
  runId: string;
  kind: AgentArtifactKind;
  label: string;
  mimeType?: string;
  content: string | Uint8Array | ArrayBuffer | Blob;
  createdAt?: number;
}

export interface ArtifactContent {
  metadata: AgentArtifact;
  bytes: Uint8Array;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function contentBytes(content: PutArtifactInput['content']): Promise<Uint8Array> {
  if (typeof content === 'string') return new TextEncoder().encode(content);
  if (content instanceof Blob) return new Uint8Array(await content.arrayBuffer());
  if (content instanceof Uint8Array) return new Uint8Array(content);
  return new Uint8Array(content.slice(0));
}

/** Durable artifact payloads and metadata, stored in the same Dexie row. */
export class ArtifactStore {
  private readonly database: TabsDB;

  constructor(database: TabsDB = db) {
    this.database = database;
  }

  async putArtifact(input: PutArtifactInput): Promise<AgentArtifact> {
    const payload = await contentBytes(input.content);
    const digestInput = new Uint8Array(payload.byteLength);
    digestInput.set(payload);
    const digest = await crypto.subtle.digest('SHA-256', digestInput.buffer);
    const createdAt = input.createdAt ?? Date.now();
    const artifact: StoredAgentArtifact = {
      id: input.id ?? generateId(),
      runId: input.runId,
      kind: input.kind,
      label: input.label,
      mimeType: input.mimeType,
      byteSize: payload.byteLength,
      contentHash: toHex(new Uint8Array(digest)),
      createdAt,
      payload,
    };

    await this.database.transaction(
      'rw',
      this.database.agentRuns,
      this.database.agentArtifacts,
      this.database.agentEvents,
      async () => {
        const run = await this.database.agentRuns.get(input.runId);
        if (!run) throw new Error(`Run ${input.runId} was not found.`);
        await this.database.agentArtifacts.add(artifact);
        const event: AgentEvent = {
          id: generateId(),
          runId: run.id,
          sequence: run.nextSequence,
          type: 'artifact.created',
          data: {
            artifactId: artifact.id,
            kind: artifact.kind,
            label: artifact.label,
            byteSize: artifact.byteSize,
            contentHash: artifact.contentHash,
          },
          createdAt,
        };
        await this.database.agentRuns.put({
          ...run,
          nextSequence: run.nextSequence + 1,
          updatedAt: createdAt,
        });
        await this.database.agentEvents.add(event);
      },
    );

    return this.withoutPayload(artifact);
  }

  async getArtifact(artifactId: string): Promise<ArtifactContent | undefined> {
    const artifact = await this.database.agentArtifacts.get(artifactId) as StoredAgentArtifact | undefined;
    if (!artifact) return undefined;
    return {
      metadata: this.withoutPayload(artifact),
      bytes: new Uint8Array(artifact.payload),
    };
  }

  async getArtifactText(artifactId: string): Promise<string | undefined> {
    const artifact = await this.getArtifact(artifactId);
    return artifact ? new TextDecoder().decode(artifact.bytes) : undefined;
  }

  async listArtifacts(runId: string): Promise<AgentArtifact[]> {
    const artifacts = await this.database.agentArtifacts.where('runId').equals(runId).sortBy('createdAt');
    return artifacts.map((artifact) => this.withoutPayload(artifact as StoredAgentArtifact));
  }

  deleteArtifact(artifactId: string): Promise<void> {
    return this.database.agentArtifacts.delete(artifactId);
  }

  deleteRunArtifacts(runId: string): Promise<number> {
    return this.database.agentArtifacts.where('runId').equals(runId).delete();
  }

  private withoutPayload(artifact: StoredAgentArtifact): AgentArtifact {
    return {
      id: artifact.id,
      runId: artifact.runId,
      kind: artifact.kind,
      label: artifact.label,
      mimeType: artifact.mimeType,
      byteSize: artifact.byteSize,
      contentHash: artifact.contentHash,
      createdAt: artifact.createdAt,
    };
  }
}

export const artifactStore = new ArtifactStore();
