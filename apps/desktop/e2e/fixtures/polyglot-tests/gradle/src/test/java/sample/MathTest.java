package sample;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

/** Fixture for the Tests panel (Java tests). */
class MathTest {
    @Test
    void adds() {
        assertEquals(3, 1 + 2);
    }

    @Test
    void failsOnPurpose() {
        assertEquals(5, 2 + 2, "2 + 2");
    }

    @Test
    @Disabled("not yet")
    void skipped() {}

    @ParameterizedTest
    @CsvSource({"1, 1", "1000, 2000"})
    void addsPairs(int a, int b) {
        assertEquals(a + b, b + a);
    }

    @Nested
    class Inner {
        @Test
        void works() {
            assertTrue("{ not a brace }".length() > 0);
        }
    }
}
