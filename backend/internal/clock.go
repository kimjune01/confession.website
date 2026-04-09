package internal

import "time"

// Now returns the current time. Tests may swap this out via NowFunc.
var NowFunc = time.Now

func Now() time.Time {
	return NowFunc()
}
