cask "forge" do
  version "0.1.0"
  sha256 :no_check  # Will be updated per release

  url "https://github.com/a-mart/forge/releases/download/v#{version}/Forge-#{version}-arm64.dmg"
  name "Forge"
  desc "Local-first multi-agent orchestration platform"
  homepage "https://github.com/a-mart/forge"

  app "Forge.app"

  zap trash: [
    "~/.forge",
    "~/Library/Application Support/forge-desktop",
    "~/Library/Preferences/com.forge.desktop.plist",
  ]
end
