import { KGExplorer } from "./components/kg-explorer";
import curatedKGData from "../data/kg.json";
import generatedKGData from "../data/generated/kg.json";
import ontologyData from "../data/ontology.json";
import type { KnowledgeBase, Ontology } from "./lib/kg";
import { mergeKnowledgeBases } from "./lib/merge";

export default function Home() {
  const knowledgeBase = mergeKnowledgeBases(
    generatedKGData as unknown as KnowledgeBase,
    curatedKGData as unknown as KnowledgeBase,
  );

  return (
    <KGExplorer
      initialKG={knowledgeBase}
      initialOntology={ontologyData as unknown as Ontology}
    />
  );
}
