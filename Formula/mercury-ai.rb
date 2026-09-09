class MercuryAi < Formula
  desc "Durable orchestration layer for long-running coding-agent runs"
  homepage "https://github.com/aywengo/mercury"
  url "https://github.com/aywengo/mercury/releases/download/host-v0.1.0/mercury-0.1.0-bundle.tar.gz"
  sha256 "37b1e40f1934ff5ecd2d589ad3b87cc98ca38d81682f308efb4832c6512f6881"
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
