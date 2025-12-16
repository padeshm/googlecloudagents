
import { BigQuery } from "@google-cloud/bigquery";
import { DynamicTool } from "@langchain/core/tools";

/**
 * Executes a BigQuery SQL query with impersonation.
 * @param {{input: string}} toolInput The tool input object, containing the SQL query string.
 * @param {import("@langchain/core/callbacks/manager").CallbackManagerForToolRun} [runManager] Optional run manager from LangChain.
 * @param {import("@langchain/core/runnables").RunnableConfig} [config] Optional config from LangChain, which should contain the user's access token.
 * @returns {Promise<string>} A promise that resolves to the query result as a JSON string, or an error message.
 */
async function runBigQueryQuery(toolInput, runManager, config) {
  const query = toolInput.input; // Destructure the query string from the input object
  console.log(`\n🤖 Executing BigQuery query: ${query}`);

  // Extract the user's access token
  const userAccessToken = config?.configurable?.userAccessToken;
  if (!userAccessToken) {
    const errorMsg = "Authentication Error: User access token not found.";
    console.error(errorMsg);
    return errorMsg;
  }

  // Initialize BigQuery with the user's credentials
  const bigquery = new BigQuery({
    credentials: {
        access_token: userAccessToken
    }
  });

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
  description: `Runs a BigQuery SQL query and returns the result as a JSON string. The input MUST be a valid and complete BigQuery SQL query.`,
  func: runBigQueryQuery,
});
