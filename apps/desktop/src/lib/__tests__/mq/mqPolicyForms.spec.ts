import { describe, expect, it } from "vitest";
import { defaultMqPolicyForms, extractKafkaRetentionConfigs, policyAccessFromEffectivePolicies, policyFormsFromEffectivePolicies, retentionWriteFlags } from "@/lib/mq/mqPolicyForms";

describe("mqPolicyForms", () => {
  it("keeps ordinary policy responses available", () => {
    expect(policyAccessFromEffectivePolicies({ configs: {} })).toEqual({
      readable: true,
      unsupportedReason: undefined,
    });
  });

  it("marks legacy Kafka configuration responses as unavailable with a reason", () => {
    expect(
      policyAccessFromEffectivePolicies({
        configs: {},
        configSupported: false,
        unsupportedReason: "The broker does not support DescribeConfigs.",
      }),
    ).toEqual({
      readable: false,
      unsupportedReason: "The broker does not support DescribeConfigs.",
    });
  });

  it("hydrates forms from topic effective policies", () => {
    const forms = policyFormsFromEffectivePolicies(
      {
        level: "topic",
        topicPolicies: {
          publishRate: {
            publishThrottlingRateInMsg: 100,
            publishThrottlingRateInByte: 2048,
          },
          dispatchRate: {
            dispatchThrottlingRateInMsg: 50,
            dispatchThrottlingRateInByte: 1024,
            ratePeriodInSecond: 5,
          },
          backlogQuota: {
            limitSize: 4096,
            limitTime: 60,
            policy: "producer_exception",
            quotaType: "message_age",
          },
          retention: {
            retentionTimeInMinutes: 120,
            retentionSizeInMB: 512,
          },
        },
      },
      defaultMqPolicyForms(),
    );

    expect(forms.publishForm.publishThrottlingRateInMsg).toBe(100);
    expect(forms.dispatchForm.ratePeriodInSecond).toBe(5);
    expect(forms.backlogForm.quotaType).toBe("message_age");
    expect(forms.retentionForm.retentionSizeInMb).toBe(512);
  });

  it("hydrates forms from namespace Pulsar policies shape", () => {
    const forms = policyFormsFromEffectivePolicies(
      {
        publishRate: {
          publishThrottlingRateInMsg: 20,
          publishThrottlingRateInByte: 3000,
        },
        subscribeRate: {
          subscribeThrottlingRatePerConsumer: 12,
          ratePeriodInSecond: 3,
        },
        backlog_quota_map: {
          destination_storage: {
            limitSize: 999,
            limitTime: 10,
            policy: "consumer_backlog_eviction",
          },
        },
        retention_policies: {
          retentionTimeInMinutes: 30,
          retentionSizeInMB: 64,
        },
      },
      defaultMqPolicyForms(),
    );

    expect(forms.publishForm.publishThrottlingRateInByte).toBe(3000);
    expect(forms.subscribeForm.ratePeriodInSecond).toBe(3);
    expect(forms.backlogForm.limitSize).toBe(999);
    expect(forms.backlogForm.quotaType).toBe("destination_storage");
    expect(forms.retentionForm.retentionTimeInMinutes).toBe(30);
  });

  it("hydrates Kafka retention from configs with MB conversion", () => {
    const forms = policyFormsFromEffectivePolicies(
      {
        configs: {
          "retention.ms": { value: "31536000000" },
          "retention.bytes": { value: "1073741824" },
        },
      },
      defaultMqPolicyForms(),
    );

    expect(forms.retentionForm.retentionTimeInMinutes).toBe(525600);
    expect(forms.retentionForm.retentionSizeInMb).toBe(1024);
  });

  it("floors non-integral time/size and keeps raw values for the hints", () => {
    const raw = {
      configs: {
        "retention.ms": { value: "90500" },
        "retention.bytes": { value: "1073741825" },
      },
    };

    const forms = policyFormsFromEffectivePolicies(raw, defaultMqPolicyForms());
    expect(forms.retentionForm.retentionTimeInMinutes).toBe(1);
    expect(forms.retentionForm.retentionSizeInMb).toBe(1024);
    expect(extractKafkaRetentionConfigs(raw)).toEqual({ timeMs: 90500, sizeBytes: 1073741825 });
  });

  it("floors sub-megabyte sizes to 0 while keeping the raw bytes for the hint", () => {
    const raw = { configs: { "retention.bytes": { value: "524288" } } };

    expect(policyFormsFromEffectivePolicies(raw, defaultMqPolicyForms()).retentionForm.retentionSizeInMb).toBe(0);
    expect(extractKafkaRetentionConfigs(raw)?.sizeBytes).toBe(524288);
  });

  it("distinguishes Kafka -1, 0 and unset retention values", () => {
    const unlimited = policyFormsFromEffectivePolicies({ configs: { "retention.ms": { value: "-1" }, "retention.bytes": { value: "-1" } } }, defaultMqPolicyForms()).retentionForm;
    expect(unlimited.retentionTimeInMinutes).toBe(-1);
    expect(unlimited.retentionSizeInMb).toBe(-1);

    const zero = policyFormsFromEffectivePolicies({ configs: { "retention.ms": { value: "0" }, "retention.bytes": { value: "0" } } }, defaultMqPolicyForms()).retentionForm;
    expect(zero.retentionTimeInMinutes).toBe(0);
    expect(zero.retentionSizeInMb).toBe(0);

    const unsetSize = policyFormsFromEffectivePolicies({ configs: { "retention.ms": { value: "0" } } }, defaultMqPolicyForms()).retentionForm;
    expect(unsetSize.retentionSizeInMb).toBeNull();
  });

  it("keeps the legacy defaults when Kafka configs contain no retention keys", () => {
    const forms = policyFormsFromEffectivePolicies({ configs: { "cleanup.policy": { value: "delete" } } }, defaultMqPolicyForms());

    expect(forms.retentionForm).toEqual({
      retentionTimeInMinutes: -1,
      retentionSizeInMb: -1,
    });
  });

  it("submits only the retention fields changed by the user", () => {
    expect(retentionWriteFlags({ time: 525600, size: 1024 }, { time: 525600, size: 1024 })).toEqual({
      writeTime: false,
      writeSize: false,
    });
    expect(retentionWriteFlags({ time: -1, size: 1024 }, { time: 525600, size: 1024 })).toEqual({
      writeTime: true,
      writeSize: false,
    });
    expect(retentionWriteFlags({ time: 0, size: 0 }, { time: null, size: null })).toEqual({
      writeTime: true,
      writeSize: true,
    });
    expect(retentionWriteFlags({ time: -1, size: null }, null)).toEqual({ writeTime: true, writeSize: false });
  });
});
