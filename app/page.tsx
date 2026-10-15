import { createExplorerPresentation } from "./lib/explorer-presentation.mjs";
import { HomePresentation } from "./components/explorer-presentation";
import knowledgeBaseData from "../data/generated/kg.json";
import ontologyData from "../data/ontology.json";
import type { Ontology } from "./lib/kg";
import manifest from "./lib/reading-manifest.generated.json";

export default function Home() {
  return (
    <HomePresentation
      presentation={createExplorerPresentation(knowledgeBaseData, "home")}
      ontology={ontologyData as unknown as Ontology}
      updateIndex={manifest.updateIndex ?? undefined}
    />
  );
}
