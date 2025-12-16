
import { BigQuery } from "@google-cloud/bigquery";
import { DynamicTool } from "@langchain/core/tools";

/**
 * Executes a BigQuery SQL query with impersonation.
 * @param {string} inputString The stringified JSON input from the agent.
 * @param {import("@langchain/core/callbacks/manager").CallbackManagerForToolRun} [runManager] Optional run manager from LangChain.
 * @param {import("@langchain/core/runnables").RunnableConfig} [config] Optional config from LangChain.
 * @returns {Promise<string>} A promise that resolves to the query result as a JSON string, or an error message.
 */
async function runBigQueryQuery(inputString, runManager, config) {
  try {
    // THE CRITICAL FIX: Parse the stringified JSON input from the agent
    const toolInput = JSON.parse(inputString);
    const query = toolInput.input;

    console.log(`\n🤖 Executing BigQuery query: ${query}`);

    const userAccessToken = config?.configurable?.userAccessToken;
    if (!userAccessToken) {
      const errorMsg = "Authentication Error: User access token not found.";
      console.error(errorMsg);
      return errorMsg;
    }

    const bigquery = new BigQuery({
      credentials: {
          access_token: userAccessToken
      }
    });

    const [rows] = await bigquery.query({ query });
    return JSON.stringify(rows);

  } catch (e) {
    // Handle both query errors and parsing errors
    const errorMessage = e.message.includes("access_token") 
      ? `Error executing query: ${e.message}` 
      : `Tool Error: Failed to parse input string or execute query. Input: ${inputString}. Error: ${e.message}`;
    console.error("ERROR in BigQuery tool:", errorMessage);
    return errorMessage;
  }
}

export const bigQueryTool = new DynamicTool({
  name: "bigquery_sql_query",
  description: `Runs a BigQuery SQL query and returns the result as a JSON string. The input MUST be a valid and complete BigQuery SQL query.`,
  func: runBigQueryQuery,
});
