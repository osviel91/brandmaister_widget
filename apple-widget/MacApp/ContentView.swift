import SwiftUI
import WidgetKit

struct ContentView: View {
    @State private var endpoint: String = ConfigStore.shared.endpoint
    @State private var talkgroup: Int = ConfigStore.shared.talkgroup
    @State private var maxRows: Int = ConfigStore.shared.maxRows
    @State private var saved = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("BrandMeister Widget Settings")
                .font(.title2).bold()

            TextField("Widget endpoint", text: $endpoint)
                .textFieldStyle(.roundedBorder)

            HStack {
                Stepper("Talkgroup: \\(talkgroup)", value: $talkgroup, in: 1...99999999)
                Stepper("Rows: \\(maxRows)", value: $maxRows, in: 1...20)
            }

            HStack {
                Button("Save and Refresh Widget") {
                    ConfigStore.shared.save(endpoint: endpoint, talkgroup: talkgroup, maxRows: maxRows)
                    WidgetCenter.shared.reloadAllTimelines()
                    saved = true
                }
                .buttonStyle(.borderedProminent)

                if saved {
                    Text("Saved")
                        .foregroundStyle(.green)
                }
            }

            Divider()

            Text("Endpoint expected format: /widget/contacts?tg=<tg>&limit=<n>")
                .font(.footnote)
                .foregroundStyle(.secondary)

            Spacer()
        }
        .padding(20)
    }
}
