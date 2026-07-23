import type { Metadata } from "next";
import { EntityGraphExplorer } from "../components/entity-graph-explorer";
import knowledgeBaseData from "../../data/generated/kg.json";
import ontologyData from "../../data/ontology.json";
import type { KnowledgeBase, Ontology } from "../lib/kg";

export const metadata: Metadata = {
  title: "实体知识图谱｜历史经纬",
  description: "选择人物、组织、地点、主题或对象，查看相关新闻时间线与知识图谱。",
};

export default function GraphPage() {
  return (
    <EntityGraphExplorer
      knowledgeBase={knowledgeBaseData as unknown as KnowledgeBase}
      ontology={ontologyData as unknown as Ontology}
    />
  );
}
