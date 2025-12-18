import { execFile } from "child_process";
import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { type CallbackManagerForToolRun } from "@langchain/core/callbacks/manager";
import { type RunnableConfig } from "@langchain/core/runnables";

const bigquerySchema = z.object({
    query: z.string().describe("A valid BigQuery SQL query."),
});

class BigQueryTool extends StructuredTool {
    name = "bigquery_sql_query";
    description = "Executes a BigQuery SQL query and returns the results. Use this for asking questions about data stored in BigQuery tables.";
    schema = bigquerySchema;

    async _call(
        { query }: z.infer<typeof bigquerySchema>,
        runManager?: CallbackManagerForToolRun,
        config?: RunnableConfig
    ): Promise<string> {
        console.log(`
🤖 Executing BigQuery Query: ${query}`);

        const userAccessToken = config?.configurable?.userAccessToken;

        if (!userAccessToken) {
            const errorMsg = "Authentication Error: User access token not found.";
            console.error(errorMsg);
            return errorMsg;
        }

        const args = ['query', '--format=json', query];

        return new Promise((resolve) => {
            execFile('bq', args,
                {
                    env: {
                        ...process.env,
                        CLOUDSDK_AUTH_ACCESS_TOKEN: userAccessToken,
                    },
                },
                (error, stdout, stderr) => {
                    if (error) {
                        const errorMessage = `Execution Error: ${error.message}
Stderr: ${stderr}`;
                        console.error(errorMessage);
                        resolve(errorMessage);
                        return;
                    }
                    if (stderr && !stdout) {
                        console.warn(`bq query command returned only stderr: ${stderr}`);
                        resolve(stderr.trim());
                        return;
                    }
                    resolve(stdout.trim());
                }
            );
        });
    }
}

export const bigqueryTool = new BigQueryTool();
