package realtime

import (
	"testing"
)

// Regression for the fail-open vector closed in the 2026-05 review:
// subscriptionMeta used to swallow every DB error and return public defaults,
// which silently disabled audience enforcement when the proxy DB role lost
// EXECUTE on the lookup function. The current code is fail-closed; this
// test pins down the prefix-exemption that keeps ad-hoc public channels
// working.

func TestIsAdHocChannel_AcceptedPrefixes(t *testing.T) {
	for _, qid := range []string{
		"_channel_lobby",
		"_channel_game_abcd",
		"_channel_",
		"_presence_room1",
		"_presence_",
	} {
		if !isAdHocChannel(qid) {
			t.Fatalf("expected %q to be an ad-hoc channel", qid)
		}
	}
}

func TestIsAdHocChannel_RejectsRegularSubscriptions(t *testing.T) {
	for _, qid := range []string{
		"electronics_in_stock",
		"inv_42",
		"channel_lobby",          // missing leading underscore
		"presence_room",          //   "
		"_otherthing_lobby",
		"",
		"foo_channel_bar",        // prefix not at the start
	} {
		if isAdHocChannel(qid) {
			t.Fatalf("expected %q to NOT be an ad-hoc channel", qid)
		}
	}
}
