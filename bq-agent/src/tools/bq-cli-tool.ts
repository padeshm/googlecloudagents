import { exec } from "child_process";
import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { CallbackManagerForToolRun } from "@langchain/core/callbacks/manager";
import type { RunnableConfig } from "@langchain/core/runnables";

const bqCliSchema = z.object({
    command: z.string().describe("The bq command arguments, without the initial 'bq' itself."),
});

class BqCliTool extends StructuredTool {
    name = "bq_cli_tool";
    description = `Executes BigQuery (bq) command-line commands for managing BigQuery resources like datasets and tables (e.g., creating, deleting, describing). It should NOT be used for querying data. The input MUST be a valid 'bq' command string, WITHOUT the 'bq' prefix.
Example: To list datasets, the input should be "ls --project_id=my-project".`;
    schema = bqCliSchema;

    async _call(
        { command }: z.infer<typeof bqCliSchema>,
        runManager?: CallbackManagerForToolRun,
        config?: RunnableConfig
    ): Promise<string> {
        console.log(`
🤖 Executing bq CLI command: bq ${command}`);

        const userAccessToken = config?.configurable?.userAccessToken;

        if (!userAccessToken) {
            const errorMsg = "Authentication Error: User access token not found.";
            console.error(errorMsg);
            return errorMsg;
        }

        return new Promise((resolve) => {
            exec(`bq ${command}`,
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
                        console.warn(`bq command returned only stderr: ${stderr}`);
                        resolve(stderr.trim());
                        return;
                    }
                    resolve(stdout.trim());
                }
            );
        });
    }
}

export const bqCliTool = new BqCliTool();
