package mathx

import "testing"

func TestAdd(t *testing.T) {
	if Add(1, 2) != 3 {
		t.Fatal("1 + 2 should be 3")
	}
}

func TestFailsOnPurpose(t *testing.T) {
	if got := Add(2, 2); got != 5 {
		t.Errorf("Add(2, 2) = %d, want 5", got)
	}
}

func TestSkipped(t *testing.T) {
	t.Skip("not yet")
}

func TestTable(t *testing.T) {
	for _, c := range []struct {
		name string
		a, b int
	}{{"small", 1, 1}, {"large", 1000, 2000}} {
		t.Run(c.name, func(t *testing.T) {
			if Add(c.a, c.b) != c.a+c.b {
				t.Fail()
			}
		})
	}
}
