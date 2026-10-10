import { describe, expect, it } from "vitest";
import { definitionFromJob, freezeJobChange, jobEnabled, jobIdentity, type OracleJobsResponse } from "@/lib/database/oracleJobs";

describe("Oracle Scheduler metadata", () => {
  it.each([
    [true, true],
    [1, true],
    ["TRUE", true],
    ["0", false],
    [false, false],
    [null, null],
    ["UNKNOWN", null],
  ])("preserves the enabled state %s", (value, expected) => {
    expect(jobEnabled(value)).toBe(expected);
  });
  it("preserves exact owner and name instead of splitting qualified strings", () => {
    expect(jobIdentity({ OWNER: 'A."B', JOB_NAME: "混合.Name" })).toEqual({ owner: 'A."B', name: "混合.Name" });
  });
  it("orders arguments and preserves quotes and multiline values", () => {
    const details: OracleJobsResponse = {
      job: { NUMBER_OF_ARGUMENTS: 2, JOB_TYPE: "STORED_PROCEDURE", JOB_ACTION: "APP.RUN", START_DATE: null, END_DATE: null, REPEAT_INTERVAL: "FREQ=DAILY" },
      argumentsAvailability: "available",
      arguments: [
        { ARGUMENT_POSITION: 2, VALUE: "two\nlines" },
        { ARGUMENT_POSITION: 1, VALUE: "it's secret" },
      ],
    };
    expect(definitionFromJob(details).arguments).toEqual(["it's secret", "two\nlines"]);
  });
  it.each([
    { job: { NUMBER_OF_ARGUMENTS: null }, argumentsAvailability: "available", arguments: [] },
    { job: { NUMBER_OF_ARGUMENTS: 1 }, argumentsAvailability: "denied", arguments: [] },
    { job: { NUMBER_OF_ARGUMENTS: 1 }, argumentsAvailability: "available", arguments: [{ ARGUMENT_POSITION: 1, VALUE: null }] },
    { job: { NUMBER_OF_ARGUMENTS: 1 }, argumentsAvailability: "available", arguments: [{ ARGUMENT_POSITION: 1 }] },
  ] as OracleJobsResponse[])("rejects incomplete or denied argument metadata", (details) => {
    expect(() => definitionFromJob(details)).toThrow();
  });
  it("takes a separate change snapshot for review", () => {
    const original = { action: "create" as const, identity: { owner: "APP", name: "J" }, definition: { jobType: "STORED_PROCEDURE", jobAction: "APP.RUN", arguments: ["old"], startDate: "", repeatInterval: "", endDate: "" } };
    const snapshot = freezeJobChange(original);
    original.definition.arguments[0] = "new";
    expect(snapshot.definition?.arguments).toEqual(["old"]);
  });
});
