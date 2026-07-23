import { KGExplorer } from "./components/kg-explorer";
import kgData from "../data/kg.json";
import ontologyData from "../data/ontology.json";
import type { KnowledgeBase, Ontology } from "./lib/kg";

export default function Home() {
  return (
    <KGExplorer
      initialKG={kgData as unknown as KnowledgeBase}
      initialOntology={ontologyData as unknown as Ontology}
    />
  );
}
