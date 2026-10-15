import { createExplorerPresentation } from "../lib/explorer-presentation.mjs";
import type { Metadata } from "next";
import { GraphPresentation } from "../components/explorer-presentation";
import knowledgeBaseData from "../../data/generated/kg.json";
import ontologyData from "../../data/ontology.json";
import type { Ontology } from "../lib/kg";

export const metadata: Metadata = {
  title: "实体知识图谱｜历史经纬",
  description: "选择人物、组织、地点、主题或对象，查看相关新闻时间线与知识图谱。",
};

export default function GraphPage() {
  return (
    <GraphPresentation
      presentation={createExplorerPresentation(knowledgeBaseData, "graph")}
      ontology={ontologyData as unknown as Ontology}
    />
  );
}
