package functions

import (
	"context"
	"fmt"

	"pgstack-proxy-go/rest"
)

// executeEmbedded runs a JavaScript function using the goja VM.
// Currently returns an error -- will be implemented when the goja dependency
// is added.
func executeEmbedded(_ context.Context, _ string, _ []byte, _ *rest.RequestClaims) ([]byte, error) {
	return nil, fmt.Errorf("embedded JS runtime not yet implemented")
}
