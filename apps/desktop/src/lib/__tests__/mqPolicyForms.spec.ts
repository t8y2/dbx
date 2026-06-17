import { describe, expect, it } from "vitest";
import { defaultMqPolicyForms, policyFormsFromEffectivePolicies } from "@/lib/mqPolicyForms";

describe("mqPolicyForms", () => {
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
});
