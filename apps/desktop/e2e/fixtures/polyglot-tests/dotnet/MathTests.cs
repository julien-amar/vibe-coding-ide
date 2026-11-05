using Xunit;

namespace SampleTests;

public class MathTests
{
    [Fact]
    public void Adds() => Assert.Equal(3, 1 + 2);

    [Fact]
    public void FailsOnPurpose() => Assert.Equal(5, 2 + 2);

    [Fact(Skip = "not yet")]
    public void Skipped() { }

    [Theory]
    [InlineData(1, 1)]
    [InlineData(1000, 2000)]
    public void AddsPairs(int a, int b) => Assert.Equal(a + b, b + a);

    public class Nested
    {
        [Fact]
        public void Works() => Assert.True(true);
    }
}
