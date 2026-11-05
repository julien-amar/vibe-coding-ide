package sample;

import static org.junit.jupiter.api.Assertions.fail;

import org.junit.jupiter.api.Test;

/**
 * Not run by Maven: Surefire's default includes are Test*, *Test, *Tests and *TestCase, so the
 * Tests panel must not list this class (if it were run, its test would fail).
 */
class MathChecks {
    @Test
    void neverRunByMaven() {
        fail("Surefire should not run MathChecks");
    }
}
