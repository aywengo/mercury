class MercuryAi < Formula
  desc "Durable orchestration layer for long-running coding-agent runs"
  homepage "https://github.com/aywengo/mercury"
  url "https://github.com/aywengo/mercury/releases/download/host-v0.1.0-rc1/mercury-0.1.0-rc1-bundle.tar.gz"
  sha256 "0d2c888161d3b17f087414e20ece64e9bc989ee296c1c2e3e774a56ba8b3739f"
  license "MIT"

  depends_on "node"

  def install
    # The bundle is prebuilt and vendors its production dependencies, so there is no build
    # step and no network access at install time.
    libexec.install Dir["*"]
    pkg = JSON.parse(File.read(libexec/"package.json"))
    pkg.fetch("bin").each do |name, rel|
      target = libexec/rel
      # The compiled entry points are mode 644 in the bundle and write_env_script execs its
      # argument directly, so they must be made executable or every command exits 126.
      target.chmod 0755
      (bin/name).write_env_script target, PATH: "#{formula_opt_bin("node")}:$PATH"
    end
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/mercury --version")
    assert_match version.to_s, shell_output("#{bin}/mercuryctl --version")
  end
end
