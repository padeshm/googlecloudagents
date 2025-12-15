import { BigQuery } from "@google-cloud/bigquery";
import { DynamicTool } from "@langchain/core/tools";

const bigquery = new BigQuery();

async function runBigQueryQuery(query) {
  console.log(`\n🤖 Executing BigQuery query: ${query}\n`);
  try {
    const [rows] = await bigquery.query({ query });
    return JSON.stringify(rows);
  } catch (error) {
    console.error("ERROR executing BigQuery query:", error);
    return `Error executing query: ${error.message}`;
  }
}

export const bigQueryTool = new DynamicTool({
  name: "bigquery_sql_query",
  description: `Runs a BigQuery SQL query and returns the result as a JSON string. Useful for answering questions about the company's data warehouse. The input MUST be a valid and complete BigQuery SQL query.`,
  func: runBigQueryQuery,
});
