"use client";

import { useMemo } from "react";
import { expandExplorerPresentation, type createExplorerPresentation } from "../lib/explorer-presentation.mjs";
import { KGExplorer, type ExplorerUpdateIndex } from "./kg-explorer";
import { EntityGraphExplorer } from "./entity-graph-explorer";
import type { KnowledgeBase, Ontology } from "../lib/kg";

type PresentationProps = { presentation: ReturnType<typeof createExplorerPresentation>; ontology: Ontology; updateIndex?: ExplorerUpdateIndex };

export function HomePresentation({ presentation, ontology, updateIndex }: PresentationProps) {
  const kg = useMemo(() => expandExplorerPresentation(presentation) as unknown as KnowledgeBase, [presentation]);
  return <KGExplorer initialKG={kg} initialOntology={ontology} updateIndex={updateIndex} />;
}

export function GraphPresentation({ presentation, ontology }: PresentationProps) {
  const kg = useMemo(() => expandExplorerPresentation(presentation) as unknown as KnowledgeBase, [presentation]);
  return <EntityGraphExplorer knowledgeBase={kg} ontology={ontology} />;
}
