import type { Entity, Event, Source } from "./kg";

export type ReleaseUpdateIndex = {
  addedNewsIds: string[]; addedEntityIds: string[]; restoredNewsIds: string[];
  restoredEntityIds: string[]; changedNewsIds: string[]; knownNewsIds: string[]; knownEntityIds: string[];
};
export type ReaderCatalog = {
  releaseId: string; recorded: boolean; hashes: Record<string, string>;
  activeNewsIds: string[]; updates: ReleaseUpdateIndex;
};
export type NewsSummary = Pick<Event, "id" | "newsId" | "title" | "date" | "datePrecision" | "summary">;
export type NewsArticleData = {
  releaseId: string; event: Event; source: Source; entities: Entity[];
  markdown: string | null; contentHash: string; contentStatus: "body" | "summary" | "unrecorded";
  related: NewsSummary[]; preview: boolean;
};
export type EntityArticleData = { entity: Entity; related: NewsSummary[]; total: number };
