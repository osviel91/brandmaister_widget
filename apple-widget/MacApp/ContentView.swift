import SwiftUI
import WidgetKit

struct ContentView: View {
    @State private var endpoint: String = ConfigStore.shared.endpoint
    @State private var talkgroup: Int = ConfigStore.shared.talkgroup
    @State private var maxRows: Int = ConfigStore.shared.maxRows
    @State private var saved = false
    @State private var contacts: [Contact] = []
    @State private var statusMessage = ""
    @State private var isLoading = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("BrandMeister Widget Settings")
                .font(.title2).bold()

            TextField("Widget endpoint", text: $endpoint)
                .textFieldStyle(.roundedBorder)

            HStack {
                Stepper("Talkgroup: \(talkgroup)", value: $talkgroup, in: 1...99999999)
                Stepper("Rows: \(maxRows)", value: $maxRows, in: 1...20)
            }

            HStack {
                Button("Save and Refresh Widget") {
                    saveSettings()
                }
                .buttonStyle(.borderedProminent)

                Button(isLoading ? "Loading..." : "Test Endpoint") {
                    Task {
                        await loadPreview()
                    }
                }
                .disabled(isLoading)

                if saved {
                    Text("Saved")
                        .foregroundStyle(.green)
                }

                if !statusMessage.isEmpty {
                    Text(statusMessage)
                        .foregroundStyle(.secondary)
                }
            }

            Divider()

            Text("Endpoint expected format: /widget/contacts?tg=<tg>&limit=<n>")
                .font(.footnote)
                .foregroundStyle(.secondary)

            GroupBox("Preview") {
                if isLoading {
                    ProgressView()
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else if contacts.isEmpty {
                    Text("No contacts loaded yet.")
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    List(Array(contacts.prefix(6).enumerated()), id: \.offset) { _, contact in
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(contact.callsign)
                                    .font(.headline)
                                Text(contact.name.isEmpty ? "Unknown operator" : contact.name)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            VStack(alignment: .trailing, spacing: 4) {
                                Text("TG \(contact.tg)")
                                    .font(.subheadline)
                                Text(contact.region.isEmpty ? contact.dmrId : "\(contact.region) - \(contact.dmrId)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                    .frame(minHeight: 150)
                }
            }

            Spacer()
        }
        .padding(20)
        .task {
            await loadPreview()
        }
    }

    private func saveSettings() {
        ConfigStore.shared.save(endpoint: endpoint, talkgroup: talkgroup, maxRows: maxRows)
        WidgetCenter.shared.reloadAllTimelines()
        saved = true
        statusMessage = "Widget reloaded"
    }

    @MainActor
    private func loadPreview() async {
        saved = false
        isLoading = true
        defer { isLoading = false }

        do {
            let payload = try await WidgetAPIClient().fetchContacts(
                endpointBase: endpoint,
                talkgroup: talkgroup,
                limit: maxRows
            )
            contacts = payload.contacts
            statusMessage = "Updated \(payload.contacts.count) contact(s)"
        } catch {
            contacts = []
            statusMessage = error.localizedDescription
        }
    }
}
