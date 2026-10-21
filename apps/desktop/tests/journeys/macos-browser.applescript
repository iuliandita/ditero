tell application "System Events"
    set diagnostic to ""
    repeat 40 times
        repeat with processName in {"CoreServicesUIAgent", "SecurityAgent", "Google Chrome"}
            if exists process (processName as text) then
                tell process (processName as text)
                    repeat with dialogWindow in windows
                        set chromeDialog to false
                        set openButton to missing value
                        set snapshot to ""
                        repeat with journeyElement in (entire contents of dialogWindow)
                            set elementName to ""
                            set elementValue to ""
                            set elementRole to ""
                            try
                                set elementName to (name of journeyElement) as text
                            end try
                            try
                                set elementValue to (value of journeyElement) as text
                            end try
                            try
                                set elementRole to (role of journeyElement) as text
                            end try
                            set snapshot to snapshot & elementRole & " | " & elementName & " | " & elementValue & linefeed
                            if elementName contains "Google Chrome" or elementValue contains "Google Chrome" then set chromeDialog to true
                            if elementRole is "AXButton" and elementName is "Open" then set openButton to journeyElement
                        end repeat
                        if chromeDialog and openButton is not missing value then
                            try
                                set frontmost to true
                            end try
                            click openButton
                            return "Accepted Chrome first-open confirmation"
                        end if
                        set diagnostic to (processName as text) & linefeed & snapshot
                    end repeat
                end tell
            end if
        end repeat
        delay 0.25
    end repeat
    return "No matching Chrome confirmation" & linefeed & diagnostic
end tell
