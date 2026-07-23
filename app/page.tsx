import { KGExplorer } from "./components/kg-explorer";
import knowledgeBaseData from "../data/generated/kg.json";
import ontologyData from "../data/ontology.json";
import type { KnowledgeBase, Ontology } from "./lib/kg";

export default function Home() {
  return (
    <KGExplorer
      initialKG={knowledgeBaseData as unknown as KnowledgeBase}
      initialOntology={ontologyData as unknown as Ontology}
    />
  );
}
