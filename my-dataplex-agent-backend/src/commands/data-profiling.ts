
import { gcloudTool } from '../tools/gcloud-tool.js';

export const createAndRunDataProfilingScan = async (table: string, project: string, location: string) => {
    const command = `dataplex data-profiling-scans create-and-run --table=${table} --project=${project} --location=${location}`;
    const result = await gcloudTool.execute({ command });
    return result;
}
