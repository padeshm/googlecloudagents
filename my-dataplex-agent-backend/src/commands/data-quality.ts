
import { gcloudTool } from '../tools/gcloud-tool.js';

export const listDataQualityRules = async (table: string, project: string, location: string) => {
    const command = `dataplex data-quality-rules list --table=${table} --project=${project} --location=${location}`;
    const result = await gcloudTool.execute({ command });
    return result;
}

export const createDataQualityRule = async (table: string, rule: any, project: string, location: string) => {
    const ruleArgs = Object.entries(rule).map(([key, value]) => `--${key}=${value}`).join(' ');
    const command = `dataplex data-quality-rules create --table=${table} ${ruleArgs} --project=${project} --location=${location}`;
    const result = await gcloudTool.execute({ command });
    return result;
}

export const updateDataQualityRule = async (ruleName: string, rule: any, project: string, location: string) => {
    const ruleArgs = Object.entries(rule).map(([key, value]) => `--${key}=${value}`).join(' ');
    const command = `dataplex data-quality-rules update ${ruleName} ${ruleArgs} --project=${project} --location=${location}`;
    const result = await gcloudTool.execute({ command });
    return result;
}
