"""
Weather Fetcher - Main Entry Point
Fetches weather FORECAST data from multiple providers and stores in SQL Server.

Providers:
- NWS (National Weather Service) - US cities
- Aviation Weather - International airports

Usage:
    python weather_fetcher.py [options]
    
Options:
    --us-only        Only fetch US cities (NWS)
    --intl-only      Only fetch international airports (Aviation)
"""

from __future__ import print_function
import sys
import traceback

# =============================================================================
# TOP-LEVEL ERROR HANDLER
# Catches import errors and other early failures that would otherwise be silent
# =============================================================================
def fatal_error(message, exception=None):
    """Print error and exit with non-zero code."""
    print("=" * 60, file=sys.stderr)
    print("FATAL ERROR - WEATHER FETCHER FAILED TO START", file=sys.stderr)
    print("=" * 60, file=sys.stderr)
    print(f"Error: {message}", file=sys.stderr)
    if exception:
        print(f"Exception: {exception}", file=sys.stderr)
        print("\nTraceback:", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
    print("=" * 60, file=sys.stderr)
    sys.exit(1)


# Wrap all imports in try/except to catch missing modules
try:
    import argparse
    from datetime import datetime
except ImportError as e:
    fatal_error("Failed to import standard library", e)

try:
    from config import US_CITIES, INTERNATIONAL_AIRPORTS, MAX_WORKERS
except ImportError as e:
    fatal_error("Failed to import config module", e)

try:
    from providers import NWSProvider, InternationalProvider, WeatherObservation
except ImportError as e:
    fatal_error("Failed to import providers module", e)

try:
    from database import (
        get_connection, 
        ensure_schema, 
        upsert_observations,
        UpsertResult
    )
except ImportError as e:
    fatal_error("Failed to import database module", e)

try:
    from logger_service import get_logger
except ImportError as e:
    fatal_error("Failed to import logger_service module", e)


# Failure thresholds
PROVIDER_FAILURE_THRESHOLD = 0.5  # Alert if more than 50% of locations fail completely
MIN_FORECAST_HOURS = 12  # Expect at least 12 hours of forecasts


def parse_args():
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="Fetch weather forecast data from multiple providers and store in SQL Server"
    )
    parser.add_argument(
        "--us-only",
        action="store_true",
        help="Only fetch US cities (NWS provider)"
    )
    parser.add_argument(
        "--intl-only",
        action="store_true",
        help="Only fetch international airports (Aviation provider)"
    )
    return parser.parse_args()


def print_progress(location_name: str, result) -> None:
    """Callback to print progress during fetch."""
    if result.error:
        print(f"  [X] {location_name}: {result.error[:60]}")
    else:
        forecasts = len(result.forecasts)
        print(f"  [OK] {location_name}: {forecasts} forecast hours")


def analyze_results(results: list) -> dict:
    """
    Analyze fetch results for issues.
    
    Returns dict with:
        - complete_failures: list of {location, error}
        - low_forecasts: list of {location, count, expected}
        - success_count: fully successful locations
    """
    analysis = {
        "complete_failures": [],
        "low_forecasts": [],
        "success_count": 0,
    }
    
    for result in results:
        # Complete failure
        if result.error:
            analysis["complete_failures"].append({
                "location": result.location_name,
                "error": result.error
            })
            continue
        
        has_issues = False
        
        # Check for low forecast count
        forecast_count = len(result.forecasts)
        if forecast_count < MIN_FORECAST_HOURS:
            analysis["low_forecasts"].append({
                "location": result.location_name,
                "count": forecast_count,
                "expected": MIN_FORECAST_HOURS
            })
            has_issues = True
        
        if not has_issues:
            analysis["success_count"] += 1
    
    return analysis


def build_issues_dict(provider_name: str, analysis: dict) -> dict:
    """Build structured issues dict for email template."""
    issues = []
    
    if analysis["complete_failures"]:
        issues.append({
            "type": "Complete Failures",
            "count": len(analysis["complete_failures"]),
            "locations": [f["location"] for f in analysis["complete_failures"]]
        })
    
    if analysis["low_forecasts"]:
        issues.append({
            "type": f"Low Forecast Count (<{MIN_FORECAST_HOURS}hrs)",
            "count": len(analysis["low_forecasts"]),
            "locations": [f"{f['location']} ({f['count']}hrs)" for f in analysis["low_forecasts"]]
        })
    
    return {provider_name: issues} if issues else {}


def run(include_us: bool = True, include_intl: bool = True) -> None:
    """
    Main execution function.
    
    Args:
        include_us: Include US cities (NWS provider)
        include_intl: Include international airports (Aviation provider)
    """
    logger = get_logger()
    logger.log_execution_context()
    
    start_time = datetime.now()
    
    # Determine which providers to use
    providers = []
    if include_us:
        providers.append(NWSProvider())
    if include_intl:
        providers.append(InternationalProvider())
    
    total_locations = sum(len(p.locations) for p in providers)
    
    print("=" * 60)
    print("WEATHER FETCHER (Current + Forecasts)")
    print("=" * 60)
    print(f"Started:     {start_time.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"Providers:   {', '.join(p.name for p in providers)}")
    print(f"Locations:   {total_locations}")
    print(f"Workers:     {MAX_WORKERS}")
    print("=" * 60)
    
    conn = None
    all_observations = []
    all_issues = {}  # Collect issues across all providers
    
    try:
        # Phase 1: Fetch from all providers (forecasts only)
        print("\n[Phase 1] Fetching weather forecasts...")
        fetch_start = datetime.now()
        
        total_success = 0
        total_locations = 0
        
        for provider in providers:
            print(f"\n  [{provider.name}] Fetching {len(provider.locations)} locations...")
            
            results = provider.fetch_all(
                include_current=True,   # Stage 4: pulled for usp_GetWeather to serve
                include_forecast=True,
                progress_callback=print_progress
            )
            
            # Collect observations (forecasts only)
            observations = provider.get_all_observations(results)
            all_observations.extend(observations)
            
            # Analyze results for issues
            analysis = analyze_results(results)
            
            success = analysis["success_count"]
            total_success += success
            total_locations += len(provider.locations)
            
            print(f"  [{provider.name}] Complete: {success}/{len(provider.locations)} fully successful")
            
            # Report issues to console
            if analysis["complete_failures"]:
                print(f"  [{provider.name}] [!] {len(analysis['complete_failures'])} complete failures")
            if analysis["low_forecasts"]:
                print(f"  [{provider.name}] [!] {len(analysis['low_forecasts'])} with low forecast counts")
            
            # Build issues for this provider
            provider_issues = build_issues_dict(provider.name, analysis)
            all_issues.update(provider_issues)
            
            # Check for critical failure rate
            failure_rate = len(analysis["complete_failures"]) / len(provider.locations) if len(provider.locations) > 0 else 0
            
            if failure_rate > PROVIDER_FAILURE_THRESHOLD:
                # Critical - more than half failed completely
                summary = {
                    "Provider": provider.name,
                    "Success Rate": f"{(1-failure_rate):.0%}",
                    "Successful": analysis["success_count"],
                    "Failed": len(analysis["complete_failures"]),
                    "Total Locations": len(provider.locations),
                }
                
                error = Exception(
                    f"Provider '{provider.name}' critical failure: "
                    f"{len(analysis['complete_failures'])}/{len(provider.locations)} locations failed ({failure_rate:.0%})"
                )
                logger.log_error(
                    error, 
                    "weather_fetcher", 
                    f"fetch_{provider.name}",
                    summary=summary,
                    issues=provider_issues,
                    is_warning=False
                )
        
        fetch_time = (datetime.now() - fetch_start).total_seconds()
        print(f"\n[TIME] Fetch completed in {fetch_time:.1f}s ({total_success}/{total_locations} fully successful)")
        
        # Phase 2: Summarize observations
        print("\n[Phase 2] Preparing CHS-API request...")
        
        forecast_count = len(all_observations)
        print(f"   Forecast records: {forecast_count}")
        
        # Check for zero records - this is a critical failure
        if forecast_count == 0:
            error = Exception("No weather forecasts collected from any provider!")
            logger.log_error(error, "weather_fetcher", "run")
            raise error
        
        # Phase 3: Database operations
        print("\n[Phase 3] Posting to CHS-API...")
        insert_start = datetime.now()
        
        conn = get_connection()
        ensure_schema(conn)
        
        result = upsert_observations(conn, all_observations)
        insert_time = (datetime.now() - insert_start).total_seconds()
        
        print(f"   Deleted:  {result.deleted} old records")
        print(f"   Inserted: {result.inserted} new records")
        print(f"   Updated:  {result.updated} existing records")
        print(f"   Time:     {insert_time:.2f}s")
        
        # Verify upsert worked
        if result.total_processed == 0 and forecast_count > 0:
            error = Exception(f"Database upsert failed: 0 records processed from {forecast_count} observations")
            logger.log_error(error, "weather_fetcher", "run")
            raise error
        
        # Summary
        total_time = (datetime.now() - start_time).total_seconds()
        print("\n" + "=" * 60)
        print("COMPLETE")
        print("=" * 60)
        print(f"Locations processed: {total_success}/{total_locations} fully successful")
        print(f"Records inserted:    {result.inserted}")
        print(f"Records updated:     {result.updated}")
        print(f"Records deleted:     {result.deleted}")
        print(f"Total time:          {total_time:.1f}s")
        print(f"Finished:            {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        
        # Send warning email if there were partial issues (but not critical)
        if all_issues:
            summary = {
                "Status": "Completed with issues",
                "Records Processed": result.total_processed,
                "Fully Successful": f"{total_success}/{total_locations}",
                "Total Time": f"{total_time:.1f}s",
            }
            
            warning = Exception("Weather fetch completed with partial data issues")
            logger.log_error(
                warning,
                "weather_fetcher",
                "partial_data_warning",
                summary=summary,
                issues=all_issues,
                is_warning=True
            )
        
        logger.log_success(f"Weather fetch complete: {result.total_processed} records processed ({result.inserted} new, {result.updated} updated)")
        
    except Exception as e:
        print(f"\n[FATAL] {e}")
        logger.log_error(e, "weather_fetcher", "run")
        raise
        
    finally:
        if conn:
            conn.close()


def main():
    """Entry point with argument parsing."""
    args = parse_args()
    
    if args.us_only and args.intl_only:
        print("Error: Cannot specify both --us-only and --intl-only")
        return 1
    
    include_us = not args.intl_only
    include_intl = not args.us_only
    
    try:
        run(
            include_us=include_us,
            include_intl=include_intl
        )
        return 0
    except Exception:
        return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        fatal_error("Uncaught exception in main", e)