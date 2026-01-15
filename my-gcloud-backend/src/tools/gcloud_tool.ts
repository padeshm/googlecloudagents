/**
 * Copyright 2025 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *	http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Tool } from "@langchain/core/tools";
import * as child_process from 'child_process';
import { BigQuery } from '@google-cloud/bigquery';
import {
  AccessControlList,
  createAccessControlList,
} from '../denylist';
import * as gcloud from '../gcloud';
import type { RunnableConfig } from "@langchain/core/runnables";
import type { CallbackManagerForToolRun } from "@langchain/core/callbacks/manager";

let lastKnownProjectId = '';

const defaultDeny = [
  'sftp',
  'ssh',
  'docker',
  'gen-repo-info-file',
];

const accessControl = createAccessControlList([], defaultDeny);

function getProjectIdFromArgs(args: string[]): string | undefined {
    const projectArg = args.find(arg => arg.startsWith('--project='));
    if (projectArg) return projectArg.split('=')[1];

    const projectIdArg = args.find(arg => arg.startsWith('--project_id='));
    if (projectIdArg) return projectIdArg.split('=')[1];

    let projectIndex = args.indexOf('--project');
    if (projectIndex !== -1 && projectIndex + 1 < args.length) {
        return args[projectIndex + 1];
    }

    projectIndex = args.indexOf('--project_id');
    if (projectIndex !== -1 && projectIndex + 1 < args.length) {
        return args[projectIndex + 1];
    }

    return undefined;
}

class GoogleCloudSDK extends Tool {
    name = 'google-cloud-sdk';
    description = `Executes a command for a Google Cloud command-line interface: gcloud, gsutil, kubectl, or bq. Input should be the full command string.`;

    async _call(
      commandString: string,
      runManager?: CallbackManagerForToolRun,
      config?: RunnableConfig
    ): Promise<string> {
      // BUILD_MARKER: V33 - The ABSOLUTE FINAL Build Fix
      console.log(`[GCLOUD_TOOL_LOG] Raw command string from agent: "${commandString}"`);

      const argRegex = /(?:[^\s"\']+|\"[^\"]*\"|\'[^\']*\')+/g;
      const rawArgs = commandString.match(argRegex) || [];
      if (rawArgs.length === 0) {
          return "Error: Invalid command. The command string cannot be empty.";
      }
      const [tool, ...args] = rawArgs.map(arg => arg.replace(/^['\"]|['\"]$/g, ''));

      if (!["gcloud", "gsutil", "kubectl", "bq"].includes(tool)) {
        return `Error: Invalid tool '${tool}'. The first word of the command must be one of gcloud, gsutil, kubectl, or bq.`;
      }

      const userAccessToken = config?.configurable?.userAccessToken;
      if (!userAccessToken) {
        return "Error: User access token is missing. Cannot authenticate.";
      }

      const projectId = getProjectIdFromArgs(args) || lastKnownProjectId;
      if (projectId) {
        lastKnownProjectId = projectId;
        console.log(`[GCLOUD_TOOL] Project ID for this operation: ${projectId}`);
      } else if (tool === 'bq') {
        return "Error: BigQuery commands require a project ID. Please specify one with --project_id.";
      }

      // --- BQ SDK LOGIC ---
      if (tool === 'bq') {
        console.log(`[GCLOUD_TOOL] Using BigQuery SDK for command: bq ${args.join(' ')}`);
        const bqClient = new BigQuery({
            credentials: { access_token: userAccessToken },
            projectId: projectId,
        });

        try {
            const [subcommand, ...bqArgs] = args;
            if (subcommand === 'ls') {
                if (bqArgs.includes('--datasets')) {
                    const [datasets] = await bqClient.getDatasets();
                    return datasets.map((d: any) => d.id).join('\n');
                }
                const datasetId = bqArgs.find(arg => !arg.startsWith('--'));
                if (datasetId) {
                    const [tables] = await bqClient.dataset(datasetId).getTables();
                    return tables.map((t: any) => t.id).join('\n');
                } 
                const [datasets] = await bqClient.getDatasets();
                return datasets.map((d: any) => d.id).join('\n');
            }

            if (subcommand === 'query') {
                const query = bqArgs.find(arg => !arg.startsWith('--'));
                if (!query) return "Error: No SQL query found for 'bq query'.";
                const [job] = await bqClient.createQueryJob({ query });
                const [rows] = await job.getQueryResults();
                // Format rows as a simple string table for the agent
                if (rows.length === 0) return "Query executed successfully and returned no rows.";
                const headers = Object.keys(rows[0]);
                const headerLine = headers.join('\t|\t');
                const dataLines = rows.map((row: any) => headers.map((h: string) => row[h]).join('\t|\t')).join('\n');
                return `${headerLine}\n${dataLines}`;
            }
            
            return `Error: The 'bq ${subcommand}' command is not yet supported by the SDK implementation.`;

        } catch (e: any) {
            console.error(`[GCLOUD_TOOL] BQ SDK Error: ${e.message}`);
            return `Error executing BigQuery command: ${e.message}`;
        }
      }

      // --- EXISTING GCLOUD/GSUTIL/KUBECTL LOGIC (WITH EXPLICIT TYPES) ---
      console.log(`[GCLOUD_TOOL] Using child_process for command: ${commandString}`);
      const env = { ...process.env };
      env['CLOUDSDK_AUTH_ACCESS_TOKEN'] = userAccessToken;
      if(projectId) env['CLOUDSDK_CORE_PROJECT'] = projectId;

      const accessControlResult = accessControl.check(args.join(' '));
      if (accessControlResult.permitted === false) {
        return accessControlResult.message;
      }
    
      return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';

        const child = child_process.spawn(tool, args, { env, shell: false });
    
        child.stdout.on('data', (data: any) => { stdout += data.toString(); });
        child.stderr.on('data', (data: any) => { stderr += data.toString(); });
    
        child.on('close', (code) => {
          console.log(`[GCLOUD_TOOL_DIAGNOSTICS] Command: '${tool} ${args.join(' ')}'`);
          console.log(`[GCLOUD_TOOL_DIAGNOSTICS] Exit Code: ${code}`);
          console.log(`[GCLOUD_TOOL_DIAGNOSTICS] STDOUT: ${stdout}`);
          console.log(`[GCLOUD_TOOL_DIAGNOSTICS] STDERR: ${stderr}`);

          if (code === 0) {
            const isSignUrl = tool === 'gcloud' && args.includes('storage') && args.includes('sign-url');
            if (isSignUrl) {
                const urlMatch = stdout.match(/^signed_url:\s*(https:\/\/.*)/m);
                if (urlMatch && urlMatch[1]) {
                    resolve(urlMatch[1].trim());
                } else {
                    resolve('Command executed successfully, but failed to extract the signed URL from the output.');
                }
            } else if (stdout.trim() === '') {
                resolve("Command executed successfully and returned no output.");
            } else {
                resolve(stdout);
            }
          } else {
            resolve(`Error: Command failed with exit code ${code}. Stderr: ${stderr}`);
          }
        });
    
        child.on('error', (err: any) => {
          resolve(`Failed to start the ${tool} process: ${err.message}`);
        });
      });
    }
}

export const googleCloudSdkTool = new GoogleCloudSDK();