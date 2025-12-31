
export const getCapabilities = () => {
    return `I can help you with a variety of Dataplex tasks. Here's a breakdown of my capabilities:

**Data Quality**
*   **List data quality scans:** "list data quality scans" or "show me the data quality jobs"
*   **Get data quality scan details:** "describe the data quality scan 'my-scan'"
*   **List data quality rules:** "list data quality rules for the table 'my-table'"
*   **Create a new data quality rule:** "create a new data quality rule for the table 'my-table' to check for null values in the 'email' column"
*   **Update an existing data quality rule:** "update the data quality rule 'my-rule' to change the threshold to 0.9"

**Data Profiling**
*   **Create and run a data profiling scan:** "run a data profiling scan on the table 'my-table'"

**General**
*   **List Dataplex assets:** "list assets in the 'my-lake' lake"
*   **Describe a Dataplex asset:** "describe the asset 'my-asset' in the 'my-lake' lake"
*   **And much more!** Just ask me a question about Dataplex, BigQuery, or Cloud Storage, and I'll do my best to help.
`;
}
